# sched-prod incident board — plan

The on-call board for sched-prod. One page, one list: tonight's incidents, newest first, so on-call sees
what just broke and takes it.

> **Decision, 2026-11-12 — product** (after the step-1 report showed the ack race): new incidents stay
> live at the top; **Ack leaves the row**. A row opens its incident panel, and Ack lives there. The panel
> names the incident it holds, so the ack always names the incident on-call is looking at, even when the
> list shifts under the pointer. R2 and the hooks below are changed accordingly.

## Flows

| flow | who | what happens |
|------|-----|--------------|
| `open-board` | on-call | opens the board; sees tonight's incidents |
| `ack-incident` | on-call | opens a row's incident panel and acks it there — "I've got this one" |
| `watch-board` | on-call | keeps the board open; it stays current without a reload |

## Requirements

- **R1** New incidents appear live at the top of the list, newest first.
- **R2** A row opens its **incident panel**, which names the incident it holds. The panel carries the
  **Ack** button; Ack sends the ack (`api.ack(id)`) and marks the incident acked — in the panel and in
  the row. Rows no longer hold Ack buttons. *(Changed by product 2026-11-12; before: an Ack button per
  row.)*
- **R3** Show a loader until incidents load.
- **R4** The board refreshes itself every 2 seconds while open. An open panel keeps naming its incident.
- **R5** Times show in the viewer's local time; day before month for EU locales (dd/mm).
- **R6** The page names its build: `<meta name="build" content="<git sha>">` in the head and the same sha in the footer.

## Hooks (pinned — tests and the replay rely on them)

| `data-testid` | element |
|---------------|---------|
| `board` | the board's main area |
| `loader` | the loader (gone once incidents load) |
| `empty` | what shows when there are no incidents |
| `incident-list` | the list |
| `incident-row` | one incident row, with `data-id="<incident id>"` |
| `incident-panel` | the incident panel, naming the incident id it holds (`data-id` + visible id) |
| `panel-ack` | the Ack button in the panel |
| `acked` | the acked mark (in the row, and in the panel) |
| `build-sha` | the sha in the footer |

*(Hook `ack` — the Ack button in a row — removed by product's decision 2026-11-12.)*

## Done

Every issue in `issues/` delivered, deployed to a public https address, and shown working.
