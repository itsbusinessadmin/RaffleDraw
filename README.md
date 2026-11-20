# Raffle Draw

Raffle Draw is a live event dashboard and audience display. GitHub Pages serves the site. An Apps Script web app authenticates operators, selects winners, and commits the complete draw to Google Sheets. The production workbook is the sole application database.

- [GitHub repository](https://github.com/itsbusinessadmin/RaffleDraw)
- [GitHub Pages settings](https://github.com/itsbusinessadmin/RaffleDraw/settings/pages)
- [Expected website](https://itsbusinessadmin.github.io/RaffleDraw/)
- [Production workbook](https://docs.google.com/spreadsheets/d/10pY8HUtzIEznO9bbK_A5Ub5uQLfiELMsHqfuU1l6arY/edit)

## 1. Authorize the Google account

Sign in to Google as the account that will own and deploy the Apps Script project. Open the production workbook and confirm you can edit it. If the workbook belongs to a different account, the workbook owner must open **Share**, invite the exact deployment account as **Editor**, and keep **General access** set to **Restricted**. Switch to that account before proceeding. For a managed Workspace account, an administrator may need to allow Apps Script or public web-app deployment. You can also use an account permitted by your organization that has Editor access to this workbook.

## 2. Create and initialize the Apps Script backend

1. Open [Apps Script](https://script.google.com/home) as the chosen owner and create a **New project** named **Raffle Draw – Production**. Replace the editor contents of `Code.gs` with [apps-script/Code.gs](apps-script/Code.gs).
2. In **Project Settings**, enable **Show “appsscript.json” manifest file in editor**. Replace the manifest with [apps-script/appsscript.json](apps-script/appsscript.json). Save. Confirm **Services** lists Google Sheets API. If you use a standard Cloud project, enable **Google Sheets API** in that project's Cloud Console too.
3. Generate two different 256-bit keys in a trusted local terminal. Run `openssl rand -hex 32` twice, or run this Node.js command twice.

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

4. In **Project Settings → Script properties**, enter `RAFFLE_ADMIN_TOKEN` and `RAFFLE_RANDOM_KEY` with the two values. Keep both in a password manager. Only the first key is entered into the operator dashboard. Set `RAFFLE_SPREADSHEET_ID` explicitly to `10pY8HUtzIEznO9bbK_A5Ub5uQLfiELMsHqfuU1l6arY`. The code defaults to this ID when the property is missing.
5. In the editor, select **verifySpreadsheetAccess → Run**. Accept the requested spreadsheet scope using the deployment account. Verify the intended workbook title and ID in **Execution log**. A permission error means the account needs sharing or Workspace authorization before you continue.
6. Select **initializeRaffle → Run**. Initialization uses one Sheets transaction and is safe to rerun. It repurposes the sole blank default tab or uses an existing `ALL IMS` tab, places it first, and creates `SETTINGS`, `PRIZES`, `DRAW_HISTORY`, and `DRAW_WINNERS` as hidden administrative tabs. Existing participant data in `ALL IMS` is retained. Initialization stops at conflicting system tabs or unexpected workbook structure.

## 3. Deploy the API

In Apps Script, select **Deploy → New deployment → Web app**. Set **Execute as** to **Me** and **Who has access** to **Anyone**. Copy the HTTPS URL ending in `/exec`. The public entry point exposes a health response. All data operations require the separate 256-bit administrator key, sent in an HTTPS POST body. The operator dashboard keeps the endpoint and administrator key in the browser profile's local site storage to reconnect after reloads and browser restarts. **Disconnect** clears the saved key. The random key stays in Apps Script.

After code changes, use **Deploy → Manage deployments → Edit → New version → Deploy** to keep the same URL. Keep one Apps Script project per workbook. Rehearsal uses a separate project and separate keys.

The browser sends a CORS-safelisted `text/plain` POST and follows the Apps Script redirect. Try it from the deployed dashboard. If the browser blocks the redirect while the URL works from a terminal, publish [gateway/worker.js](gateway/worker.js) as a Cloudflare Worker on the free plan. In Cloudflare **Workers & Pages**, create a Worker, replace its code with that module, and add these variables under **Settings → Variables and Secrets**:

- `APPS_SCRIPT_URL` is the production `/exec` URL.
- `PAGES_ORIGIN` is `https://itsbusinessadmin.github.io`.

Deploy the Worker and enter its root `https://…workers.dev/` URL in **Connect**. The gateway only forwards to the fixed Apps Script URL and adds CORS headers for the configured Pages origin. Keep the key out of Worker configuration and request logging. Review [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas), [Sheets API limits](https://developers.google.com/workspace/sheets/api/limits), and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) if you use the gateway.

## 4. Publish GitHub Pages

1. Review and merge the application pull request into `main`.
2. In [Settings → Pages](https://github.com/itsbusinessadmin/RaffleDraw/settings/pages), set **Build and deployment → Source** to **GitHub Actions**.
3. In **Actions → GitHub Pages**, run the workflow on `main` if it did not run after merging or if Pages had yet to be enabled. Approve the environment deployment if your repository requires it. The workflow runs the tests and publishes the contents of `site/`, where lowercase `index.html` and all relative assets are served under `/RaffleDraw/`.
4. Open the expected URL, select **Connect**, and supply the API URL and administrator key. Confirm **Sheets connected**. You can prefill the public API URL in `site/config.js` as a later commit. Only the URL belongs there.

## 5. Prepare and operate the event

- Enter or paste participant records into `ALL IMS`. Put column headings on row 1 and keep headers unique. If importing a CSV through Google Sheets, paste into the existing tab or import into a temporary tab and copy the values across. Preserve the existing `ALL IMS` sheet.
- Use a stable, unique ID per person under **Participant ID** when available. Format this column as plain text before pasting identifiers with leading zeros. The first draw touching an imported roster assigns and persists IDs for eligible rows with missing IDs. Duplicate display names can be legitimate. Preserve the assigned IDs across imports so prior winners can still be recognized. If you have employee IDs in a differently named column, rename that header to `Participant ID`.
- From **Settings**, enter the event name, select the participant name heading, and set the **Spin duration**, **Name scroll speed**, and **Winner display time** independently. Scroll speed is the average number of names per second. Automatic mode advances after the display time. Manual mode enables **Next winner** or **Finish draw** after the same wait, and the winner stays on screen until you continue. Reduced motion skips the spin. Deploy the updated Apps Script version to enable the timing settings.
- Select **Add prize**, enter its exact desired worksheet name, total winner limit and per-draw size, and save. To rename, use **Edit** in the dashboard. The worksheet title changes in place and past draw receipts retain the title recorded at the time.
- Turn on **All participants** for a prize to include people still in **ALL IMS** and people who won other prizes, including archived prizes. Each person can win that prize once. People manually removed without a recorded win need to be added to the roster. Deploy the updated Apps Script version to enable this option.
- Use **Open projector** to open a separate presentation window. Move it to the second display and choose **Enter fullscreen**. Keep the dashboard that opened it running. Use the left arrow to choose **Automatic** or **Manual**. Start the selected prize with **Draw** below the gold ticket. In Manual mode, the same button becomes **Next winner** or **Finish draw**.
- To draw from a phone, connect the PC and phone dashboards to the same raffle API. Open the fullscreen projector from the PC dashboard, then select the prize and run the draw on the phone. The projector checks for updates every 1.5 seconds, so network and Apps Script response times add a short delay. Use the phone dashboard to advance manual reveals. Deploy the updated Apps Script version to enable cross-device sync.
- While a winner is on the fullscreen projector from the local dashboard, choose **Re-draw** and confirm to replace that winning spot with a different eligible name. The prize worksheet and winner ledger update together. The removed winner returns to **ALL IMS** if they have no other wins. Deploy the updated Apps Script version to enable re-draws.
- Choose a prize and advancement mode, then click **Draw** once. The entire award batch commits before the first reel starts. The batch size is the least of per-draw size, remaining prize slots, and eligible participants. In Manual mode, **Finish draw** clears the gold ticket, selects the next open prize in list order, and waits for **Draw**. If no other prize is open, the winner list stays on screen below the empty ticket. **Pause**, **Skip spin**, **Next winner**, and **Reveal all** affect presentation only. Reduced-motion settings keep the result and sequence while skipping the spin.
- If a request fails after you click Draw, use **Retry pending draw**. The browser saved its transaction ID before submitting. A recovered request returns the original results if already committed. You can reopen the dashboard in the same browser profile and retry after it reconnects.
- Completed prizes show their awarded count in the prize picker and cannot be selected. Resetting a prize returns its winners to **ALL IMS** and clears their wins for that prize. Keep the prize worksheet and roster column layout intact so the records can be restored.
- Use an archive icon or **Select** to archive prizes and hide them from the table and draw picker. Both the main list and **Archived** offer **Select All** in selection mode. Open **Archived** to restore one or more prizes. In the main list you can also reset or permanently delete prizes after confirming. Deleting a prize first restores any winners to **ALL IMS**, then removes the prize and its worksheet. Deploy the updated Apps Script version to use deletion.

### Record handling

During draws, use the dashboard for event and prize changes. Schedule manual roster imports or edits between draws. Script locking coordinates operators using the API. Direct spreadsheet edits operate outside the script lock. Keep system sheets and the `RAFFLE_WRITE_VERSION` named range intact.

A draw uses one atomic Sheets API batch to write missing participant IDs, copy every selected record to its exact prize worksheet, update the winner and transaction ledgers, and remove the selected rows from **ALL IMS**. A record copied from an earlier prize stays on that prize's worksheet. Filled data columns and existing ID cell values travel with the record. Formula cells are copied as their current values. A reset or deletion restores a winner to the bottom of the roster when they have no other awards and retains canceled transaction IDs to prevent stale retries. Preserve the roster column layout while prizes have winners.

The backend derives a pseudorandom stream from HMAC-SHA-256 with a private 256-bit key, and uses rejection sampling and a partial Fisher–Yates shuffle for unbiased sampling without replacement. A transaction ID binds a prize to a durable receipt, and a one-use Sheets named range rejects stale mutation batches. Counts and event-wide eligibility come from the roster and the winner ledger.

## 6. Verify with an isolated rehearsal

**Local verification** uses Node.js 20+ and an in-memory test adapter for the Sheets API. No participant data leaves your machine.

```sh
npm test
```

**Live verification** requires a separate workbook and backend. Create a Google Spreadsheet titled **Raffle Rehearsal** and follow setup steps 1–3 in a new Apps Script project, using the rehearsal sheet ID and different keys. Add [tests/Rehearsal.gs](tests/Rehearsal.gs) to the rehearsal project only. Run `verifySpreadsheetAccess`, `initializeRaffle`, and `seedRehearsal`; copy the exact `RAFFLE_REHEARSAL_EVENT` value printed in the execution log. Deploy the rehearsal web app.

Supply the URL and the log value; enter the rehearsal token without echoing it. For the optional Pages check, include the trailing slash on the published URL.

```sh
export RAFFLE_API_URL='https://script.google.com/macros/s/REHEARSAL_DEPLOYMENT_ID/exec'
export RAFFLE_REHEARSAL_EVENT='Raffle Rehearsal REHEARSAL_UUID_FROM_EXECUTION_LOG'
export RAFFLE_PAGES_URL='https://itsbusinessadmin.github.io/RaffleDraw/'
read -rs -p 'Rehearsal administrator key: ' RAFFLE_ADMIN_TOKEN
export RAFFLE_ADMIN_TOKEN
npm run test:rehearsal
unset RAFFLE_ADMIN_TOKEN
```

Run **verifyRehearsal** in the rehearsal editor. The API harness tests authentication, 1,050 entrants, prize creation and renaming, two 10-person draws, concurrent draws, an interrupted-response retry, and persistent results. The editor verifier checks the exact destination sheets, data fields, unique IDs, and all 1,050 rows after transfer. Run the harness once per freshly seeded workbook.

Use the published dashboard with a separate rehearsal workbook to check the real names scrolling with the correct committed winner centered, projector fullscreen, automatic progression, manual progression, pause/resume, skip and reveal all. Refresh the same tab, verify it reconnects, and confirm the same winners in the spreadsheet. Confirm a prize reset returns its winners to **ALL IMS** and leaves other prizes’ winners in place. Disconnect, then reconnect to your production API. Import only real participant data into production.
