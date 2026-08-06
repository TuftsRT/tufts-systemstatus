# Changelog

All notable changes to Tufts System Status are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-07-30

### Added

- **Clickable GPU and partition cards (drill-down).** Cards in *GPU Overview* and
  *Partitions* are now buttons. Selecting one filters *Node Details* to the
  matching nodes and opens a drill-down panel above the table showing:
  - free capacity and node count for the selection — GPUs when a GPU type is
    selected, otherwise CPUs,
  - one chip per node (sorted by free capacity, biggest block first) that jumps
    to and highlights that node's row when clicked,
  - the partitions the matching nodes belong to, or — for a partition selection
    — its time limit and idle node count,
  - a warning when any matching node is under an active reservation,
  - one copy-ready `srun` command per resource the selection can actually give
    you (see below).

  **One card at a time.** Selecting a card replaces any previous selection, so
  there is never more than one filter active. The current selection shows as a
  single removable chip in the panel.

  **Contributed lab nodes list both routes onto the same hardware.** A lab-owned
  GPU node normally sits in both the lab's partition and the shared `preempt`
  partition. Both are real routes to that node, so selecting such a GPU card lists
  a command for each, shared partitions first, with a plain-text note stating which
  flag applies to whom:

  > `-p smith-lab` is a lab-owned partition — only members of **smith_lab or
  > tts_rsch_hpc_admin** can submit there. Everyone else reaches the same nodes
  > with `-p preempt`, where a job runs until the owning lab needs the node and is
  > then preempted.

  The note is rendered as a tinted callout card at 12px, distinctly quieter than
  the commands above it, with the partition flags set in the mono face. Slurm's
  comma-separated group lists are rendered as prose (`smith_lab,tts_rsch_hpc_admin`
  becomes "smith_lab or tts_rsch_hpc_admin").

  Only when contributed nodes are in *no* shared partition does the note say there
  is no general-access route — and that is checked against the nodes' own partition
  lists, not against which rows happen to be on screen, so pinning a lab partition
  still points non-members at the shared route.

  Partition ownership comes from Slurm's `AllowGroups`/`AllowAccounts` rather than
  being inferred from partition names. Which partitions are preemptible is site
  policy, listed in `PREEMPTIBLE_PARTITIONS` in `public/script.js` (`preempt`
  only). It is deliberately *not* taken from Slurm's `PreemptMode`, because
  `scontrol show partition` reports the cluster-wide default for partitions that do
  not override it, which marked unrelated partitions as preemptible.

  **Mixed partitions get one example command per case.** A partition containing
  CPU-only nodes and two GPU models cannot be described by a single `srun` line —
  `--gres=gpu:a100:1` is invalid on a CPU node and on a V100 node. The panel
  therefore lists one tagged, separately copyable command per case: a CPU-only
  job first, then one per GPU model ordered by free GPUs, each labelled with how
  much of that resource is free. Each GPU command resolves its partition from that
  model's own nodes, so an H100 request is never paired with a partition that only
  has V100s. Commands take the form
  `srun -p <partition> -N 1 -n 1 -c 4 [--gres=… | --mem=8G] --pty bash`.

  The **Available GPUs** stat card selects every GPU type at once. A partition
  selection also offers *Scope dashboard to this partition*, which promotes it to
  the global partition scope so the stat cards, GPU cards and active-user list
  follow. A toggle (*Only nodes with free GPUs* for a GPU selection, *Only nodes with
  spare capacity* for a partition) switches between "what can I use right now" and
  "every matching node".

  Selecting a card resets a stale search/status filter so results are never
  silently empty; search and the status dropdown then combine with the
  selection. Cards are keyboard operable (Tab, then Enter/Space) and keep focus
  across re-renders, selections survive auto-refresh, and they are dropped
  automatically when the partition scope no longer contains them.
- **Reservation indicator** in the node table: nodes under an `ACTIVE`
  reservation are marked so apparently-free GPUs are not mistaken for usable
  ones.
- **`demo/build_preview.rb`** generates `demo/preview.html`, an offline copy of
  the dashboard backed by mock Slurm data, so the UI can be developed without a
  live cluster.
- **`demo/css_audit.rb`** asserts that the drill-down panel's style rules exist as
  own rules with the declarations that carry their intent. Added after a CSS
  cleanup silently removed `.drilldown-hints-note`'s own rule while leaving its
  descendant rules in place, so the class still looked defined and the note
  quietly inherited the panel's much larger font.

### Fixed

- **Allocated GPUs were not detected, so every GPU node looked completely free.**
  `gpu_alloc` was read only from `AllocTRES`, which carries `gres/*` entries on
  some Slurm versions and configurations but not others. Where it does not, every
  GPU node reported all of its GPUs as free. The visible symptom was the GPU card
  label counting *every* node of a type as having free GPUs, but the same bad
  input also inflated the per-type availability, the "Available GPUs" stat, the
  node table, and the drill-down totals. `GresUsed` — the authoritative per-node
  GRES usage field in `scontrol show node` output — is now the primary source,
  with both `AllocTRES` spellings kept as fallbacks.
- **GRES parsing mistook a numeric GPU model name for the GPU count.** A node with
  `Gres=gpu:2080ti:8` did not match the typed pattern, then matched the untyped
  one and reported *2080* GPUs. GRES fields are now split on `:` instead of
  pattern-matched, which handles `gpu:4`, `gpu:a100:4`, `gpu:2080ti:4`,
  `gpu:a100:4(IDX:0-3)`, and `shard:8,gpu:a100:2` uniformly.
- **`gpu_alloc` is clamped to `gpu_count`** and `gpu_free` floored at zero, so
  inconsistent input cannot produce negative availability.
- **Card labels promised a different node count than clicking delivered.** The GPU
  card said "Show N nodes with free GPUs" while the partition card counted the
  partition's entire node set. Both now report "Show N of M nodes …", counted from
  the same node data the table filters on, so the label and the resulting table
  can no longer disagree.
- **GPU nodes were invisible to a partition drill-down when their CPUs were fully
  allocated.** The example commands and the node list were both derived from the
  availability-filtered node set, and for a partition selection "available" meant
  free *CPUs*. Because GPU jobs typically request every core on a node, a busy GPU
  node has zero free CPUs while its GPUs are free — so a GPU partition showed only
  the CPU-only example. Example commands are now derived from what the selection
  can be *asked for* (all schedulable matching nodes, regardless of momentary
  availability), and the availability toggle counts spare CPUs **or** spare GPUs.
  Commands also stay visible when nothing is currently free, since the request is
  still valid — it just queues.
- **Untyped GRES was treated as a CPU node.** When `scontrol` reports
  `Gres=gpu:4` with no model name, the old pattern (`gpu:<name>:<count>`) did not
  match, `has_gpu` was never assigned, and the node was indistinguishable from a
  CPU-only node — missing from the GPU cards, the GPU summary, and the example
  commands. Such nodes are now recognised, reported as GPU type `gpu`, and
  requested as `--gres=gpu:1` (no model segment).
- **A non-GPU `Gres` value left `has_gpu` as nil rather than false.** A node with
  e.g. `Gres=shard:8` fell through every branch, so the field was absent from the
  JSON. The GPU fields are now always initialised.
- **Typed `AllocTRES` GPU counts were ignored.** Slurm may report allocated GPUs
  as `gres/gpu=4`, `gres/gpu:a100=4`, or both. Only the plain form was matched, so
  on sites using the typed spelling every busy GPU appeared free.

### Changed

- **New `SlurmParser.parse_partition_access`** reads `scontrol show partition` and
  reports `owner_only` per partition, from `AllowGroups`/`AllowAccounts`, alongside
  the values themselves. These appear on each entry in `partition_summary`.
  `owner_only` describes who may submit to *that partition*, never whether its
  nodes are reachable, since contributed nodes are normally also in a shared
  preemptible partition. If the command is unavailable, nothing is claimed.
- `SlurmParser#parse_nodes` now also records `gpu_base_type`, the raw `Gres`
  name (e.g. `a100`). The displayed `gpu_type` may be refined into a
  feature-based variant such as `a100-80G`, which is a node *feature* and not a
  valid `--gres` value; keeping both lets the generated `srun` hint use
  `--gres=gpu:a100:1 --constraint=a100-80G` correctly.
- Node table cells and partition card fields are HTML-escaped.
- The generated `srun` hint only suggests `--gres=gpu:…` when a GPU type is
  actually selected. A partition-only selection gets a plain CPU command, rather
  than inferring a GPU request from whichever GPU nodes happen to be in the
  partition.

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

[1.2.0]: https://github.com/TuftsRT/tufts-systemstatus/releases/tag/v1.2.0
[1.1.0]: https://github.com/TuftsRT/tufts-systemstatus/releases/tag/v1.1.0
[1.0.0]: https://github.com/TuftsRT/tufts-systemstatus/releases/tag/v1.0.0
