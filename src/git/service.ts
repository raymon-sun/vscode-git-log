import { injectable } from "inversify";
import simpleGit, { SimpleGit } from "simple-git";

import { EventEmitter, workspace } from "vscode";

import { API } from "../typings/scmExtension";

import { getBuiltInGitApi, getGitBinPath } from "./api";

import { GitOptions, LogOptions } from "./types";
import { parseGitCommits } from "./commit";
import { parseGitChanges } from "./changes/changes";
import { getUser } from "./utils";

@injectable()
export class GitService {
	private gitExt?: API;
	private git?: SimpleGit;
	private readonly rootRepoPath = workspace.workspaceFolders![0].uri.fsPath;

	private storedRepos: string[] = [];
	private readonly reposEvent = new EventEmitter<string[]>();

	constructor() {
		this.initializeGitApi();
	}

	private async initializeGitApi() {
		this.gitExt = (await getBuiltInGitApi())!;

		const gitBinPath = await getGitBinPath();

		this.git = simpleGit(this.rootRepoPath, { binary: gitBinPath });

		this.initializeReposEvents();
	}

	private initializeReposEvents() {
		const handler = () => {
			this.storedRepos = this.getRepositories() || [];
			this.reposEvent.fire(this.storedRepos);
		};

		this.gitExt?.onDidOpenRepository(handler);
		this.gitExt?.onDidCloseRepository(handler);
	}

	getDefaultRepository() {
		const workspacePath = workspace.workspaceFolders![0].uri.fsPath;
		const repos = this.getRepositories();

		return repos.find((fsPath) => fsPath === workspacePath) || repos[0];
	}

	getRepositories() {
		return (
			this.gitExt?.repositories.map(({ rootUri }) => rootUri.fsPath) || []
		);
	}

	getRefs(options: GitOptions) {
		const { repo = this.rootRepoPath } = options;
		return this.git
			?.cwd(repo)
			.raw(
				"for-each-ref",
				"--sort",
				"-committerdate",
				"--format=%(objectname) %(refname)"
			)
			.then((res) => {
				const refs: { hash: string; type: string; name: string }[] = [];
				res.split("\n").forEach((item) => {
					if (!item) {
						return;
					}

					const [, hash, type, name] =
						item.match(
							/^([A-Fa-f0-9]+) refs\/(heads|remotes|tags)\/(.*)$/
						) || [];

					if (hash && type && name) {
						refs.push({ hash, type, name });
					}
				});

				return refs;
			});
	}

	getAuthors(options: GitOptions) {
		const { repo = this.rootRepoPath } = options;
		return this.git
			?.cwd(repo)
			?.raw("shortlog", "-ens", "HEAD")
			.then((res) => {
				const shortlogs = res.split("\n");
				return shortlogs
					.filter((shortlog) => !!shortlog)
					.map((shortlog) => getUser(shortlog));
			})
			.catch((err) => {
				console.log(err);
			});
	}

	async show(commitHash: string, filePath: string) {
		// TODO: record repo path in file node / replace gitExt
		const repoPath = this.getRepositories()
			.sort((fsPathA, fsPathB) => fsPathB.length - fsPathA.length)
			.find((fsPath) => filePath.startsWith(fsPath));

		return await this.gitExt?.repositories
			.find((repo) => repo.rootUri.fsPath === repoPath)!
			.show(commitHash, filePath);
	}

	async getCommits(options?: LogOptions) {
		const COMMIT_FORMAT = "%H%n%D%n%aN%n%aE%n%at%n%ct%n%P%n%B";
		const { repo, authors, keyword, ref, maxLength, count, skip } =
			options || {};
		const args = [
			"log",
			`--format=${COMMIT_FORMAT}`,
			"-z",
			ref || "--all",
			"--author-date-order",
		];

		if (authors && authors.length) {
			args.push(...authors.map((author) => `--author=${author}`));
		}

		if (keyword) {
			args.push(`--grep=${keyword}`);
		}

		if (maxLength) {
			args.push(`-n${maxLength}`);
		}

		if (skip) {
			args.push(`--skip=${skip}`);
		}

		if (count) {
			args.push(`-${count}`);
		}

		return await this.git
			?.cwd(repo || this.rootRepoPath)
			.raw(args)
			.then((res) => parseGitCommits(res))
			.catch((err) => console.log(err));
	}

	async getCommitsTotalCount(options?: LogOptions) {
		const { repo } = options || {};
		const args = ["rev-list", "--all", "--count"];
		return await this.git
			?.cwd(repo || this.rootRepoPath)
			.raw(args)
			.catch((err) => console.log(err));
	}

	async getChangesCollection(repoPath: string, refs: string[]) {
		return await Promise.all(
			refs.map((ref) =>
				this.getChangesByRef(repoPath, ref).then((changes) => ({
					ref,
					changes,
				}))
			)
		);
	}

	async getChangesByRef(repoPath: string, ref: string) {
		const args = [
			"log",
			"-p",
			"-1",
			"--pretty=format:",
			"--name-status",
			"-z",
			ref,
		];

		return await this.git!.cwd(repoPath || this.rootRepoPath)
			.raw(args)
			.then((res) => parseGitChanges(repoPath, res));
	}

	onReposChange(handler: (repos: string[]) => void) {
		handler(this.storedRepos);
		this.reposEvent.event((repos) => {
			handler(repos);
		});
	}
}
