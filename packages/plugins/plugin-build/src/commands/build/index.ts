import { BaseCommand } from "@yarnpkg/cli";
import {
  Configuration,
  MessageName,
  Project,
  StreamReport,
  miscUtils,
} from "@yarnpkg/core";
import { PortablePath } from "@yarnpkg/fslib";
import { Command, Option, Usage } from "clipanion";
import path from "path";

import { EventEmitter } from "events";
import { GetPluginConfiguration, YarnBuildConfiguration } from "../../config";
import RunSupervisor, { RunSupervisorReporterEvents } from "../supervisor";

import { addTargets } from "../supervisor/workspace";

export default class Build extends BaseCommand {
  static paths = [
    [`build`],
  ];

  json = Option.Boolean(`--json`, false);
  buildCommand = Option.String(`-c,--build-command`, `build`);
  parallel = Option.Boolean(`-p,--parallel`, true);
  interlaced = Option.Boolean(`-i,--interlaced`, false);
  verbose = Option.Boolean(`-v,--verbose`, false);
  dryRun = Option.Boolean(`-d,--dry-run`, false);
  ignoreBuildCache = Option.Boolean(`--ignore-cache`, false);
  buildTarget = Option.Rest();

  static usage: Usage = Command.Usage({
    category: `Build commands`,
    description: `build a package and all its dependencies`,
    details: `
      In a monorepo with internal packages that depend on others, this command
      will traverse the dependency graph and efficiently ensure, the packages
      are built in the right order.

      - If \`-p,--parallel\` and \`-i,--interlaced\` are both set, Yarn
      will print the lines from the output as it receives them.
      Parallel defaults to true.

      If \`-i,--interlaced\` wasn't set, it would instead buffer the output
      from each process and print the resulting buffers only after their
      source processes have exited. Defaults to false.

      If the \`--json\` flag is set the output will follow a JSON-stream output
      also known as NDJSON (https://github.com/ndjson/ndjson-spec).

      \`-c,--build-command\` is the command to be run in each package (if available), defaults to "build"
    `,
  });

  // Keep track of what is built, and if it needs to be rebuilt
  buildLog: { [key: string]: { hash: string | undefined } } = {};

  async execute() {
    const configuration = await Configuration.find(
      this.context.cwd,
      this.context.plugins
    );

    const pluginConfiguration: YarnBuildConfiguration = await GetPluginConfiguration(configuration);

    const report = await StreamReport.start(
      {
        configuration,
        json: this.json,
        stdout: this.context.stdout,
        includeLogs: true,
      },
      async (report: StreamReport) => {
        let targetDirectory = this.context.cwd;

        if (
          pluginConfiguration.enableBetaFeatures.targetedBuilds &&
          typeof this.buildTarget[0] === "string"
        ) {
          targetDirectory = `${configuration.projectCwd}${path.sep}${this.buildTarget[0]}` as PortablePath;
        }

        const { project, workspace: cwdWorkspace } = await Project.find(
          configuration,
          targetDirectory
        );

        const targetWorkspace = cwdWorkspace || project.topLevelWorkspace;

        const runScript = async (
          command: string,
          cwd: PortablePath,
          buildReporter: EventEmitter,
          prefix: string
        ) => {
          const stdout = new miscUtils.BufferStream();
          stdout.on("data", (chunk) =>
            buildReporter?.emit(
              RunSupervisorReporterEvents.info,
              prefix,
              chunk && chunk.toString()
            )
          );

          const stderr = new miscUtils.BufferStream();
          stderr.on("data", (chunk) =>
            buildReporter?.emit(
              RunSupervisorReporterEvents.error,
              prefix,
              chunk && chunk.toString()
            )
          );

          try {
            const exitCode =
              (await this.cli.run(["run", command], {
                cwd,
                stdout,
                stderr,
              })) || 0;

            stdout.end();
            stderr.end();

            return exitCode;
          } catch (err) {
            stdout.end();
            stderr.end();
          }
          return 2;
        };

        const supervisor = new RunSupervisor({
          project,
          configuration,
          pluginConfiguration,
          report,
          runCommand: this.buildCommand,
          cli: runScript,
          dryRun: this.dryRun,
          ignoreRunCache: this.ignoreBuildCache,
          verbose: this.verbose,
        });

        await supervisor.setup();

        await addTargets({ targetWorkspace, project, supervisor });

        // build all the things
        const ranWithoutErrors = await supervisor.run();
        if (ranWithoutErrors === false) {
          report.reportError(MessageName.BUILD_FAILED, "Build failed");
        }
      }
    );

    return report.exitCode();
  }
}
