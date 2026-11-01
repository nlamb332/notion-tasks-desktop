# Jira integration

Jira Cloud projects can be connected alongside Notion and Plane. Issues appear in the same lists, compact widget, and planner as other tasks.

## Setup

1. Create an API token at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) under **Security → API tokens**. Use a classic token without scopes.
2. In **Settings → Connections**, enter your site (`https://your-team.atlassian.net`), account email, and token, then choose **Connect Jira**.
3. In **Settings → Sources**, choose a project or paste a project, board, or issue URL. Confirm the mapping.

The app acts as you, so it can do only what your Jira account can do.

## What syncs

- **Issues:** those assigned to you in each connected project. Completed issues stay for 30 days after their last update, so completed lists and planner cleanup keep working.
- **Editing:** the summary, due date, and status save back to Jira. Due dates are date-only.
- **Status changes:** these use your workflow's transitions. If the workflow has no direct move to the mapped status, the app reports that and changes nothing, including other fields in the same edit.
- **New tasks:** these become `Task` issues, or the project's first standard issue type, assigned to you so they appear in the list. If the project requires other fields, Jira rejects the create and the error is shown.
- **Conflicts:** an edit is refused if the issue changed in Jira after the app last read it.

## Limits

- Jira Cloud only. Data Center and Server sites are not supported.
- The project picker shows the first 100 projects. Paste a URL for any others.
- Issues assigned to someone else, or unassigned, do not appear.
- A status list covers the whole project, so a mapped status might not apply to every issue type.

## Security

The token is encrypted with Windows-backed `safeStorage` in `jira-token.enc` and is never sent to the renderer. The site and email are stored in `jira-config.json`. Requests go only to the connected `atlassian.net` site over HTTPS, and redirects are refused so credentials cannot be forwarded. **Disconnect** removes the token and the site configuration.

## Testing

`npm test` covers the service against a mocked Jira API. `node scripts/jira-smoke.mjs`, part of `npm run test:desktop`, drives connecting, source setup, planning references, a status transition, and disconnecting in Electron with a fixture API. Neither calls a real Jira site.
