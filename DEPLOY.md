# Deployment

EarthWatch has a static website and a scheduled Python batch. Vercel serves the website, GitHub Actions runs ingestion, and Vercel Blob stores the latest public snapshot. No application server runs continuously.

## 1. Prepare the repository

The repository root contains `dist/`, `pipeline/`, `package.json`, `package-lock.json`, `vercel.json` and `.github/workflows/refresh-data.yml`.

If the generated snapshot was previously tracked, stop tracking it before committing this change:

```sh
git rm --cached --ignore-unmatch dist/data/observations.json
git add .
git diff --cached --stat
git commit -m "Separate data publication from website deployments"
git push -u origin main
```

`git rm --cached` keeps your local file. `.gitignore` prevents future snapshots from entering Git. Existing history is not rewritten. Local notes, SQLite, raw responses, credentials and `node_modules` remain excluded. Do not use `git add -f` for these files.

Uploading Actions workflows requires workflow-authorized Git credentials. Run authentication and push commands separately if using GitHub CLI.

## 2. Create the data store

1. In Vercel, open **Storage** and create a dedicated **Blob** store for EarthWatch. Select **public** access. A public store is intentional: the normalized observation file is publicly readable.
2. Obtain the store's **read-write token** (`BLOB_READ_WRITE_TOKEN`) from its connection/token settings. If the UI offers a token for external use, use that store-scoped token.
3. In GitHub, open the repository's **Settings -> Secrets and variables -> Actions -> Secrets**, then **New repository secret**.
4. Name it **BLOB_READ_WRITE_TOKEN** and paste the token as its value. Do not put it in source code, `dist/config.json`, a commit or a public log. The static website does not need the token.

Vercel's interface may require a project association. You may import the repository first as described in step 5, then return here. Its first deployment will have no hosted data until step 4 is complete. Review the plan's Blob usage limits before enabling a schedule.

## 3. Run the pipeline manually

1. In GitHub, open **Actions -> Refresh EarthWatch data -> Run workflow**.
2. Select the default branch and run it. The schedule is gated by a repository variable, so this manual run works before hourly automation is enabled.
3. Inspect the tests, ingestion counts and **Replace the public data snapshot** step. A successful publication prints **Public snapshot URL** ending in `/earthwatch/observations.json`.
4. Open that URL and confirm it returns JSON with `schemaVersion`, `generatedAt`, `sources` and `observations`.

No NASA MAP_KEY is required for the public FIRMS download used here. The workflow receives GitHub's own token automatically for state artifacts. A source failure retains the previous successful observations, publishes failure metadata when possible and ends the job in failure. Check all three source statuses even when publication succeeds.

## 4. Point the website at the snapshot

Edit `dist/config.json`, replacing the empty string with the exact public URL printed by the publisher:

```json
{
  "snapshotUrl": "https://YOUR-STORE.public.blob.vercel-storage.com/earthwatch/observations.json"
}
```

Use the plain public URL without query parameters or credentials. Commit and push the configuration:

```sh
git add dist/config.json
git commit -m "Configure hosted observation snapshot"
git push
```

The URL is safe to publish; it grants read access only. Keep the write token in the Actions secret. An empty URL is for local development and reads `dist/data/observations.json`, which is generated locally rather than shipped to Vercel.

## 5. Deploy the website

1. In Vercel, choose **Add New -> Project** and import this GitHub repository.
2. Use framework preset **Other**, the repository root as root directory, and **dist** as output directory.
3. Keep `vercel.json`. Its empty install command skips Node dependencies because the website needs no compilation; the Blob SDK is used only in GitHub Actions.
4. Deploy and wait for **Ready**. Open the production URL and check the globe, snapshot age, source status and observation details. It should not say **Local snapshot**.
5. If the project was imported earlier, the configuration push should create the updated deployment; check that it finished Ready.

No frontend environment variables or deploy hooks are needed. Remove an old `VERCEL_DEPLOY_HOOK` Actions secret if one was created for the earlier workflow; the new workflow does not use it.

## 6. Enable hourly refreshes

In GitHub repository **Settings -> Secrets and variables -> Actions -> Variables**, create **EARTHWATCH_SCHEDULE_ENABLED** with the value **true**. It is a repository variable, not a secret. The workflow on the default branch runs at minute 17 of each hour, UTC. Schedules may be delayed; they are not an exact timer.

```text
Hourly GitHub runner starts
  -> restore SQLite and recent raw responses
  -> test and ingest three public feeds
  -> export and validate JSON
  -> replace the same Blob object
  -> save state for the next run
Runner shuts down

Visitor's browser -> Vercel website -> public Blob JSON
```

Your computer can be off. Browser refresh reads data; it does not start ingestion. The app checks for new data every five minutes while visible. Blob cache lifetime is 60 seconds, so updates may take a few minutes to appear. Website deployments happen when you push code/configuration changes, rather than on each hourly refresh.

## Storage, usage and recovery

| Storage | Contents | Retention |
| --- | --- | --- |
| Vercel deployment | HTML, JavaScript, CSS and public URL configuration | Vercel deployment retention settings |
| Vercel Blob | One latest `earthwatch/observations.json` object | Replaced on each publication |
| GitHub Actions artifacts | SQLite and recent raw responses | Two newest artifacts, seven-day expiry |

The snapshot can be around 15 MB, depending on source activity. Replacing the same Blob object avoids keeping a new hourly filename or deployment. Storage, uploads and visitor download traffic still count toward usage; this is not unlimited free hosting. Check Vercel Blob and GitHub Actions usage after your first day. Frequent browser downloads can matter more than the single stored file.

Raw responses and record revisions are retained for seven days; run logs for fourteen days. SQLite may retain allocated disk space after deleting rows. If all state artifacts expire, the next run starts a fresh database. If an upload fails, the existing published object is not intentionally deleted; inspect the run and retry. A failed browser request preserves the last loaded snapshot only within that browser session.

To pause hourly runs, change **EARTHWATCH_SCHEDULE_ENABLED** to **false**. Existing data remains readable and its timestamps show its age. GitHub can disable schedules after repository inactivity. This project is not an indefinite archive or an emergency alert service.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Storage preflight fails | Exact Actions secret name and nonempty store token |
| Publication fails | Public store, token permissions, export validation and service availability |
| Website has no observations | Public URL in `dist/config.json`, latest configuration deployment and Actions publication |
| Website data is old | Last Actions run, source status, schedule variable and snapshot generation time |
| Hourly job is skipped | Repository variable equals `true`, and workflow is on default branch |
| Fire markers missing | FIRMS source status, time window, layer toggle, search and watch-area scope |

## References

- [Vercel Blob public storage](https://vercel.com/docs/vercel-blob/public-storage)
- [Blob SDK: overwrite and cache options](https://vercel.com/docs/vercel-blob/using-blob-sdk)
- [Blob usage and pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing)
- [Vercel Git deployments](https://vercel.com/docs/git)
- [GitHub scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Workflow artifacts](https://docs.github.com/en/actions/using-workflows/storing-workflow-data-as-artifacts)
