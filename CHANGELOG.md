# Changelog

All notable changes to Tufts System Status are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-07-14

### Fixed

- **Job name parsing in cluster-wide job stats.** `parse_all_jobs` now runs
  `squeue` with `-h` and a `|` field delimiter and rebuilds the job name from
  the middle columns. Previously, whitespace splitting broke on job names
  containing spaces, shifting every subsequent column and corrupting the parsed
  state/node/partition values.

### Changed

- **Resilient command execution.** `run_command` no longer raises when a Slurm
  command fails. It logs the exit status and STDERR to the server log and
  returns the (possibly empty) stdout, so a single failing command degrades that
  section gracefully instead of blanking the entire dashboard. Diagnostics are
  written to STDERR (was STDOUT).
- **Manifest** `category: ""` for the embedded dashboard view.

## [1.0.0] - Initial release

- Real-time cluster status dashboard: GPU availability, partitions, node
  inventory, and CPU/GPU resource details.

[1.1.0]: https://github.com/TuftsRT/tufts-systemstatus/releases/tag/v1.1.0
[1.0.0]: https://github.com/TuftsRT/tufts-systemstatus/releases/tag/v1.0.0
