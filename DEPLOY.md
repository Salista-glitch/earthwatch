# Deployment

EarthWatch has a static frontend and a scheduled Python batch. Vercel hosts the frontend; GitHub Actions runs ingestion. There is no continuously running application server.

## Repository setup

Push the source to a GitHub repository. The repository root must contain `dist/`, `pipeline/`, `vercel.json` and `.github/workflows/refresh-data.yml`. Python database files, raw responses, credentials and local notes must remain excluded by `.gitignore`.

Uploading Actions workflows requires credentials permitted to create or update workflow files. For GitHub CLI authentication, see [gh auth login](https://cli.github.com/manual/gh_auth_login) and [Git credential setup](https://cli.github.com/manual/gh_auth_setup-git).

## Vercel

1. Import the GitHub repository into a Vercel project.
2. Use framework preset **Other**, repository root as the root directory, and **dist** as the output directory.
3. Keep the checked-in `vercel.json` configuration. No dependency installation or application compilation is required.
4. Deploy and wait for **Ready**. Verify the globe, source status, snapshot age and observation details.

No runtime environment variables are required by the static frontend. Older snapshots remain identifiable by their timestamps.

## Scheduled ingestion

The workflow currently runs at minute 17 each hour, in UTC, and also supports manual dispatch. It restores the previous state artifact, runs tests, executes `python pipeline/refresh.py`, preserves state, commits the public JSON export and requests a Vercel deployment. The runner shuts down after the job finishes. Browser refresh does not start ingestion.

Before enabling the schedule, review Vercel deployment retention and usage. This version redeploys for each data refresh and commits snapshots to Git history. Separate object-storage publication is not implemented. The schedule can be removed from the workflow or disabled in GitHub Actions while deployment configuration is being prepared.

For explicit deployment requests:

1. In Vercel project settings, create a **Git -> Deploy Hook** for the production branch.
2. Save the hook URL as a GitHub repository Actions secret named **VERCEL_DEPLOY_HOOK**.
3. Keep the URL out of Git, public issues and logs. It authorizes deployment requests.
4. Dispatch **Refresh EarthWatch data** manually on the default branch.
5. Inspect the batch log and state artifact, then check Vercel for the final deployment status.

The workflow needs repository content-write and Actions artifact-management permissions. Branch protection can prevent the snapshot commit. Pipeline-generated commits may also trigger Git-integrated deployments; review duplicate triggers and retention before unattended operation. A successful hook request does not prove Vercel finished publishing.

NASA's public NOAA-20 CSV download does not require a MAP_KEY. GitHub provides the workflow token automatically. Hosted jobs do not depend on a local computer remaining switched on.

## State and recovery

- Vercel and Git retain published snapshots.
- The two newest `earthwatch-state` artifacts retain SQLite and recent raw responses. Each artifact expires after seven days.
- Raw-response and revision retention is seven days; run-log retention is fourteen days.
- A failed source retains its previous successful observations and is marked failed in the exported snapshot. The workflow ends in failure after publishing available results and source status.
- If no artifact can be restored, a new database is created. This is bounded state retention, not an indefinite archive.
- Raw-response expiry uses recorded ingestion times rather than extracted file modification times.

GitHub schedules may be delayed or dropped. Scheduled workflows must exist on the default branch; public repository schedules may be disabled after inactivity. Source status marks retrievals older than three hours as delayed. Database disk allocation may remain larger after old rows are deleted.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Website loads but data is old | Last Actions run, source status, hook configuration and latest Vercel deployment |
| Source failure | Batch error and previous successful retrieval; rerun after the source recovers |
| Snapshot commit fails | Actions permissions, branch protection and concurrent repository changes |
| Missing fire markers | FIRMS layer, watch-area scope, time window, search and source status |
| Data request succeeds but deployment is unchanged | Vercel's asynchronous deployment status and published snapshot timestamp |

## References

- [Vercel Git deployments](https://vercel.com/docs/git)
- [Deploy Hooks](https://vercel.com/docs/deploy-hooks)
- [Deployment retention](https://vercel.com/docs/deployment-retention)
- [GitHub scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Workflow artifacts](https://docs.github.com/en/actions/using-workflows/storing-workflow-data-as-artifacts)
