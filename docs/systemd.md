# Start ClusterODX at boot (systemd)

`restart.sh` starts ClusterODX in the background from an interactive shell. It
does not run at boot, so a reboot leaves ClusterODX down. The unit in
[`contrib/systemd/clusterodx.service`](../contrib/systemd/clusterodx.service)
starts it at boot and restarts it if it crashes.

## Install

Edit `User`, `Group`, `WorkingDirectory`, the `--tmp-dir` path and the
`RequiresMountsFor` path to match the host. The unit passes the same arguments
as `restart.sh`. If `splat-config.json` does not exist, remove the
`--splat-config` line.

```bash
sudo cp contrib/systemd/clusterodx.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clusterodx
journalctl -u clusterodx -f
```

Logs go to the journal, not `log/clusterodxYYYYMMDD.log`. Add
`StandardOutput=append:<path>` to the `[Service]` section to write a file.

Once systemd owns the process, restart with `sudo systemctl restart clusterodx`.
Do not also run `restart.sh`, which would start a second copy on the same ports.

## Restart only when idle

Pending submissions are held in memory and are lost on restart or reboot. A
Tapis job whose task was `queued`, `submitting` or `waiting_registration` then
starts without a handoff and fails registration with 403. Check the admin API
before any planned restart or reboot:

```bash
# TAPIS_JWT: a valid Tapis access token allowed by admin-web-allowed-* (if set)
curl -sf -H "Authorization: Bearer $TAPIS_JWT" http://localhost:10000/r/task/list \
  | jq '[.[] | select(.state | IN("queued","submitting","waiting_registration","assigned"))]'
curl -sf -H "Authorization: Bearer $TAPIS_JWT" http://localhost:10000/r/splat/list \
  | jq '[.[] | select(.state | IN("ready","failed","canceled") | not)]'
```

Both arrays should be empty. `assigned` means a route exists, not that the job
is still running (the endpoint makes no live Tapis calls), so it can keep a
finished task listed. A failed `curl` (401, 403, 503, connection refused) must
not be treated as "idle". See [Admin task visibility](tapis.md#admin-task-visibility).
