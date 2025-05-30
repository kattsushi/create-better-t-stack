import os from "node:os";
import path from "node:path";
import {
	cancel,
	confirm,
	isCancel,
	log,
	select,
	spinner,
	text,
} from "@clack/prompts";
import consola from "consola";
import { $ } from "execa";
import fs from "fs-extra";
import pc from "picocolors";
import { commandExists } from "../utils/command-exists";

type TursoConfig = {
	dbUrl: string;
	authToken: string;
};

type TursoGroup = {
	name: string;
	locations: string;
	version: string;
	status: string;
};

async function isTursoInstalled() {
	return commandExists("turso");
}

async function isTursoLoggedIn() {
	try {
		const output = await $`turso auth whoami`;
		return !output.stdout.includes("You are not logged in");
	} catch {
		return false;
	}
}

async function loginToTurso() {
	const s = spinner();
	try {
		s.start("Logging in to Turso...");
		await $`turso auth login`;
		s.stop("Logged in to Turso successfully!");
		return true;
	} catch (error) {
		s.stop(pc.red("Failed to log in to Turso"));
	}
}

async function installTursoCLI(isMac: boolean) {
	const s = spinner();
	try {
		s.start("Installing Turso CLI...");

		if (isMac) {
			await $`brew install tursodatabase/tap/turso`;
		} else {
			const { stdout: installScript } =
				await $`curl -sSfL https://get.tur.so/install.sh`;
			await $`bash -c '${installScript}'`;
		}

		s.stop("Turso CLI installed successfully!");
		return true;
	} catch (error) {
		if (error instanceof Error && error.message.includes("User force closed")) {
			s.stop("Turso CLI installation cancelled");
			log.warn(pc.yellow("Turso CLI installation cancelled by user"));
			throw new Error("Installation cancelled");
		}
		s.stop(pc.red("Failed to install Turso CLI"));
	}
}

async function getTursoGroups(): Promise<TursoGroup[]> {
	const s = spinner();
	try {
		s.start("Fetching Turso groups...");
		const { stdout } = await $`turso group list`;
		const lines = stdout.trim().split("\n");

		if (lines.length <= 1) {
			s.stop("No Turso groups found");
			return [];
		}

		const groups = lines.slice(1).map((line) => {
			const [name, locations, version, status] = line.trim().split(/\s{2,}/);
			return { name, locations, version, status };
		});

		s.stop(`Found ${groups.length} Turso groups`);
		return groups;
	} catch (error) {
		s.stop(pc.red("Error fetching Turso groups"));
		console.error("Error fetching Turso groups:", error);
		return [];
	}
}

async function selectTursoGroup(): Promise<string | null> {
	const groups = await getTursoGroups();

	if (groups.length === 0) {
		return null;
	}

	if (groups.length === 1) {
		log.info(`Using the only available group: ${pc.blue(groups[0].name)}`);
		return groups[0].name;
	}

	const groupOptions = groups.map((group) => ({
		value: group.name,
		label: `${group.name} (${group.locations})`,
	}));

	const selectedGroup = await select({
		message: "Select a Turso database group:",
		options: groupOptions,
	});

	if (isCancel(selectedGroup)) {
		cancel(pc.red("Operation cancelled"));
		process.exit(0);
	}

	return selectedGroup as string;
}

async function createTursoDatabase(dbName: string, groupName: string | null) {
	const s = spinner();

	try {
		s.start(
			`Creating Turso database "${dbName}"${groupName ? ` in group "${groupName}"` : ""}...`,
		);

		if (groupName) {
			await $`turso db create ${dbName} --group ${groupName}`;
		} else {
			await $`turso db create ${dbName}`;
		}

		s.stop(`Created database "${dbName}"`);
	} catch (error) {
		s.stop(pc.red(`Failed to create database "${dbName}"`));
		if (error instanceof Error && error.message.includes("already exists")) {
			throw new Error("DATABASE_EXISTS");
		}
	}

	s.start("Retrieving database connection details...");
	try {
		const { stdout: dbUrl } = await $`turso db show ${dbName} --url`;
		const { stdout: authToken } = await $`turso db tokens create ${dbName}`;

		s.stop("Retrieved database connection details");

		return {
			dbUrl: dbUrl.trim(),
			authToken: authToken.trim(),
		};
	} catch (error) {
		s.stop(pc.red("Failed to retrieve database connection details"));
	}
}

async function writeEnvFile(projectDir: string, config?: TursoConfig) {
	const envPath = path.join(projectDir, "apps/server", ".env");
	const envContent = config
		? `DATABASE_URL="${config.dbUrl}"
DATABASE_AUTH_TOKEN="${config.authToken}"`
		: `DATABASE_URL=
DATABASE_AUTH_TOKEN=`;

	await fs.ensureDir(path.dirname(envPath));
	await fs.writeFile(envPath, envContent);
}

function displayManualSetupInstructions() {
	log.info(`Manual Turso Setup Instructions:

1. Visit https://turso.tech and create an account
2. Create a new database from the dashboard
3. Get your database URL and authentication token
4. Add these credentials to the .env file in apps/server/.env

DATABASE_URL=your_database_url
DATABASE_AUTH_TOKEN=your_auth_token`);
}

import type { ProjectConfig } from "../types";

export async function setupTurso(config: ProjectConfig): Promise<void> {
	const { projectName, orm, projectDir } = config;
	const isDrizzle = orm === "drizzle";
	const setupSpinner = spinner();
	setupSpinner.start("Setting up Turso database");

	try {
		const platform = os.platform();
		const isMac = platform === "darwin";
		const isLinux = platform === "linux";
		const isWindows = platform === "win32";

		if (isWindows) {
			setupSpinner.stop(pc.yellow("Turso setup not supported on Windows"));
			log.warn(pc.yellow("Automatic Turso setup is not supported on Windows."));
			await writeEnvFile(projectDir);
			displayManualSetupInstructions();
			return;
		}

		setupSpinner.stop("Checking Turso CLI");

		const isCliInstalled = await isTursoInstalled();

		if (!isCliInstalled) {
			const shouldInstall = await confirm({
				message: "Would you like to install Turso CLI?",
				initialValue: true,
			});

			if (isCancel(shouldInstall)) {
				cancel(pc.red("Operation cancelled"));
				process.exit(0);
			}

			if (!shouldInstall) {
				await writeEnvFile(projectDir);
				displayManualSetupInstructions();
				return;
			}

			await installTursoCLI(isMac);
		}

		const isLoggedIn = await isTursoLoggedIn();
		if (!isLoggedIn) {
			await loginToTurso();
		}

		const selectedGroup = await selectTursoGroup();

		let success = false;
		let dbName = "";
		let suggestedName = path.basename(projectDir);

		while (!success) {
			const dbNameResponse = await text({
				message: "Enter a name for your database:",
				defaultValue: suggestedName,
				initialValue: suggestedName,
				placeholder: suggestedName,
			});

			if (isCancel(dbNameResponse)) {
				cancel(pc.red("Operation cancelled"));
				process.exit(0);
			}

			dbName = dbNameResponse as string;

			try {
				const config = await createTursoDatabase(dbName, selectedGroup);

				const finalSpinner = spinner();
				finalSpinner.start("Writing configuration to .env file");
				await writeEnvFile(projectDir, config);
				finalSpinner.stop("Turso database configured successfully!");

				success = true;
			} catch (error) {
				if (error instanceof Error && error.message === "DATABASE_EXISTS") {
					log.warn(pc.yellow(`Database "${pc.red(dbName)}" already exists`));
					suggestedName = `${dbName}-${Math.floor(Math.random() * 1000)}`;
				} else {
				}
			}
		}
	} catch (error) {
		setupSpinner.stop(pc.red("Failed to set up Turso database"));
		consola.error(
			pc.red(
				`Error during Turso setup: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
		await writeEnvFile(projectDir);
		displayManualSetupInstructions();
		log.success("Setup completed with manual configuration required.");
	}
}
