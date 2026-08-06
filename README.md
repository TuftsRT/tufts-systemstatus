# System Status for Tufts Open OnDemand

A real-time web dashboard for monitoring SLURM cluster status, including GPU availability, partition information, and node details.

## Features

- **Real-time Monitoring**: Auto-refreshes every 30 seconds (configurable)
- **GPU Overview**: Visual cards showing GPU types, availability, and usage
- **Partition Summary**: Status of all partitions with node counts and limits
- **Node Details**: Sortable and filterable table of all cluster nodes
- **Cluster Statistics**: Quick overview of total resources, availability, and system-wide job counts
- **Responsive Design**: Works on desktop and mobile devices

## Installation

This app is designed to run as a Passenger Rack app in Open OnDemand (OOD). No Gemfile or Bundler are required because OOD already ships with a Ruby runtime and Sinatra for Passenger apps.

### Requirements

- Open OnDemand environment (Passenger + per-user NGINX)
- SLURM client tools (sinfo, scontrol, squeue)
- Shell PATH for the Passenger process must be able to locate `sinfo`, `scontrol`, `squeue`

### Setup

1. Place this directory in your OOD apps area. Common options:

   - User dev space: `~/ondemand/dev/cluster-dashboard/` or `~/ondemand/prod/cluster-dashboard/`
   - System app (admin): `/var/www/ood/apps/sys/cluster-dashboard/`

2. Restart the app (or your PUN) so Passenger reloads it:

   ```bash
   cd /path/to/cluster-dashboard
   mkdir -p tmp && touch tmp/restart.txt
   ```

   Or use the “Restart App” button in the OOD UI.

3. Launch from the OOD dashboard. The app will be mounted under a sub-URL like `/pun/dev/cluster-dashboard`.

#### Customizing navigation

By default a new menu item named "Cluster Monitor" is added in the "Cluster" menu.  To embeed this inside the standard dashboard view replacing the built in "System Status" make the following changes. The path /etc/ood/config/apps/**dashboard/views/system_status/** to place the override at is derived from the builtin location /var/www/ood/apps/sys/**dashboard/app/views/system_status/**\index.html.erb
1. Remove separate menu item for cluster-dashboard
   - Option A) Set **category:** value in /var/www/ood/apps/sys/cluster-dashboard/manifest.yml to a empty 
   - Option B) Remove manifest file `rm /var/www/ood/apps/sys/cluster-dashboard/manifest.yml`
2. Replace the build in system-status view by adding a symbolic link to our new file. 
   - `ln -s /var/www/ood/apps/sys/cluster-dashboard/views/dashboard_iframe.html.erb /etc/ood/config/apps/dashboard/views/system_status/index.html.erb`

Notes:

- A Gemfile is not necessary. If you add one, OOD will try to run Bundler which may require outbound network access and additional configuration. This app is intentionally Gemfile‑free to work with OOD’s provided environment.

## File Structure

```
cluster-dashboard/
├── manifest.yml          # OOD app metadata
├── config.ru             # Rack configuration
├── app.rb                # Sinatra web application
├── lib/
│   └── slurm_parser.rb   # SLURM command parser module
├── views/
│   └── index.erb         # Main dashboard template
├── public/
│   ├── styles.css        # Dashboard styling
│   └── script.js         # Client-side JavaScript
└── README.md             # This file
```

## API Endpoints

The dashboard provides several API endpoints:

- `GET /` - Main dashboard page
- `GET /api/data` - Complete dashboard data (all information used by the UI)
- `GET /api/nodes` - Node information only
- `GET /api/gpu` - GPU summary only
- `GET /api/partitions` - Partition information only
- `GET /health` - Health check endpoint

## Features in Detail

### GPU Overview

- Shows all GPU types in the cluster
- Displays total, available, in-use, and down GPUs
- Visual progress bar for usage percentage
- Color-coded cards for easy identification

### Partition Summary

- Lists all SLURM partitions
- Shows node counts by status (idle, mixed, allocated, down)
- Displays available CPUs and time limits
- Highlights default partition and GPU-enabled partitions

### Node Details Table

- Complete list of all cluster nodes
- Sortable by any column (click headers)
- Filterable by status or GPU availability
- Search functionality for quick node lookup
- Shows CPU, memory, GPU, and partition information

### Cluster Statistics

- System-wide job counts (total jobs, running jobs, pending jobs across all users)
- Total and available CPUs across the cluster
- Total and available memory
- Node availability overview

## Customization

### Change Auto-Refresh Interval

Edit `public/script.js`:

```javascript
this.refreshIntervalMs = 30000; // Change to desired milliseconds
```

### Modify Colors

Edit `public/styles.css` to change the CSS variables:

```css
:root {
  --primary: #3498db;
  --success: #2ecc71;
  --warning: #f39c12;
  --danger: #e74c3c;
  /* ... */
}
```

### Add More SLURM Commands

Edit `lib/slurm_parser.rb` to parse additional SLURM commands or add custom logic.

### Enable Browser Debug Logs

Append `?debug=1` to the app URL to print concise, copyable logs to the browser console:

```
https://<ood-host>/pun/dev/cluster-dashboard?debug=1
```

Shows fetched stats, partitions, GPU summary, and node details.

## How It Works (at a glance)

1. Browser loads `/` → serves `views/index.erb` with CSS/JS.
2. Frontend calls `GET /api/data` every 30s.
3. Backend (`lib/slurm_parser.rb`) executes live SLURM commands:
   - `scontrol show node --oneliner` (nodes, CPUs, memory, GPUs, partitions, state)
   - `sinfo -o "%P %a %l %D %t"` (partition availability, time limits, counts)
   - `squeue -o "%i %j %u %t %M %D %C %b %P %N"` (system-wide job statistics for all users)
4. Backend parses output and returns JSON; frontend renders cards/tables.

GPU "in‑use" is estimated for mixed/allocated nodes using CPU usage ratio; for exact GPU accounting you can extend parsing to include per-job GRES usage.

## Finding available resources (card drill-down)

The cards under **GPU Overview** and **Partitions** are clickable. Selecting one
filters **Node Details** to the matching nodes and opens a panel above the table
with:

- free capacity and node count for the selection — GPUs when a GPU type is
  selected, otherwise CPUs
- one chip per node, ordered by free capacity (largest block first) — click a chip
  to jump to and highlight that node's row
- which partitions those nodes belong to; for a partition selection, its time
  limit and idle node count instead
- a warning if any matching node is under an active reservation
- one copy-ready `srun` command per resource the selection can actually give you

**One card at a time.** Selecting a card replaces any previous selection, so there
is only ever a single filter. The active one appears as a chip in the panel with an
× to clear it; clicking the selected card again also deselects it.

Clicking the **Available GPUs** stat card selects every GPU type at once. A
partition selection additionally offers **Scope dashboard to this partition**,
which promotes it to the global partition scope at the top of the page so the stat
cards, GPU cards, and active-user list all follow.

Use the checkbox (*Only nodes with free GPUs* for a GPU selection, *Only nodes with
spare capacity* for a partition) to switch between "what can I run on right now"
and "every matching node". Cards are keyboard operable: Tab to a card, then Enter
or Space.

The search box and the status dropdown combine with the selection, so you can
narrow further — e.g. GPU type + `idle`.

### Example `srun` commands

Many partitions hold both CPU-only nodes and more than one GPU model, and no single
`srun` line covers them — `--gres=gpu:a100:1` is invalid on a CPU node and on a
V100 node. So the panel lists one command per case, each separately copyable and
labelled with the free capacity behind it. For a partition with CPU nodes plus
A100s and V100s:

```
[CPU only]  srun -p preempt -N 1 -c 4 --mem=8G --pty bash
                                                        24 of 64 CPUs free on 1 node
[A100-80G]  srun -p preempt -N 1 -c 4 --gres=gpu:a100:1 --constraint=a100-80G --pty bash
                                                        11 of 16 GPUs free on 3 nodes
[V100]      srun -p preempt -N 1 -c 4 --gres=gpu:v100:1 --pty bash
                                                         3 of 4 GPUs free on 1 node
```

Clicking a specific GPU card collapses this to the commands for that model — one
per partition that reaches those nodes.

### Contributed (lab) nodes

A lab-owned GPU node normally sits in **both** the lab's own partition and the
shared `preempt` partition. Both are genuine routes to the same hardware, so both
are listed — shared partitions first:

```
[preempt  ]  srun -p preempt -N 1 -c 4 --gres=gpu:l40s:1 --pty bash     7 of 8 free
[smith-lab]  srun -p smith-lab -N 1 -c 4 --gres=gpu:l40s:1 --pty bash   7 of 8 free

-p smith-lab is a lab-owned partition — only members of smith_lab can submit there.
Everyone else reaches the same nodes with -p preempt, where a job runs until the
owning lab needs the node and is then preempted.
```

So lab members use `-p smith-lab`; everyone else uses `-p preempt` to get onto the
same hardware, accepting preemption. The dashboard only reports that there is no
general-access route when the nodes really are absent from every shared partition —
checked against the nodes' own partition lists, so pinning a lab partition still
points non-members at the shared route.

Ownership comes from Slurm's `AllowGroups`/`AllowAccounts`, not from partition
naming, so it stays correct as labs are added or renamed. If
`scontrol show partition` is unavailable, no partition is treated as lab-owned and
no note is shown.

Which partitions are preemptible is site policy, listed in
`PREEMPTIBLE_PARTITIONS` at the top of `public/script.js` (just `preempt` today).
This is deliberately not derived from Slurm's `PreemptMode`: `scontrol show
partition` reports the cluster-wide default for any partition that does not set its
own, which would mark unrelated partitions preemptible.

The list reflects what the selection can be **asked for**, not only what is free at
this instant, so a model whose GPUs are all busy still appears (with `0 of N free`)
— the request is valid, it just queues. Nodes that are down or draining are never
offered. Only the node list and counts respond to the availability toggle.

Two details worth knowing:

- When a GPU type is shown as a variant such as `A100-80G`, the suffix comes from a
  Slurm node *feature*, not from the `Gres` name — hence
  `--gres=gpu:a100:1 --constraint=a100-80G`.
- Each GPU command picks its partition from that model's own nodes, so an H100
  request is never paired with a partition that only has V100s. A partition-only
  selection never infers a GPU request you did not ask for.
- Sites that configure GRES without a model name (`Gres=gpu:4`) are shown as GPU
  type `GPU` and requested as `--gres=gpu:1`, with no model segment.

The commands are starting points: `-N 1` requests a single node, and `-c 4`,
`--mem=8G`, and the GPU count of `1` are placeholders to adjust for your job.

## Local UI development (no cluster required)

`demo/build_preview.rb` renders the real template and assets against mock Slurm
data, producing a standalone page you can open directly in a browser:

```bash
ruby demo/build_preview.rb
open demo/preview.html
```

The preview stubs `fetch`, so it needs no server and no Slurm. Re-run the script
after editing `views/index.erb`.

## Troubleshooting

### Dashboard shows "No data"

- Ensure SLURM commands are accessible from the web server
- Check that sinfo, scontrol, and squeue are in the PATH
- Verify permissions to execute SLURM commands

### See “App is missing Gemfile” / “Not a valid git repo”

- These warnings in the OOD dev panel are informational and safe to ignore for this app. It does not require a Gemfile.

### Auto-refresh not working

- Check browser console for JavaScript errors
- Ensure the `/api/data` endpoint is accessible
- Try disabling and re-enabling auto-refresh toggle

### Styling issues

- Clear browser cache
- Check that `public/styles.css` is loading correctly. The app uses `request.script_name` to reference assets under OOD’s sub‑URL; if you change templates, ensure those paths remain relative to the mount point.
- Verify Font Awesome CDN is accessible

## License

Created by Javier Laveaga. This app is provided as-is for use in Open OnDemand environments.

## Support

For issues or questions, consult your local Open OnDemand administrator.
