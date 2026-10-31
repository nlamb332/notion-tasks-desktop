# Connect a Notion calendar

The Notion connection uses a database with an existing title property and date property. You can display the same database in Notion Calendar. Google calendars that you view in the separate Notion Calendar app should be connected through this app's Google option.

1. Connect Notion in **Settings → Connection**, using an integration with access to the calendar database. Share each original database with that integration in Notion's **Connections** menu.
2. Open **Planning** and the live calendar connection controls. Paste the original calendar database link and inspect it.
3. Select its title field and the date field that represents scheduled events. Use a dedicated event database or a scheduled-time field rather than a task deadline field.
4. Add the calendar, select it as a calendar to read, and optionally make it the default destination for approved task blocks. You can select Google calendars at the same time.
5. Refresh and generate a plan. Approval creates event pages in the default destination, with the scheduled start/end range and a link to the original task. It does not change the original task deadline or create database properties.

Timed events require both a start and an end; a point deadline does not establish a busy interval. Date-only entries block their local dates, including a selected range's final date. Use the correct calendar timezone. Notion integration permissions apply; a successful database inspection does not prove that the integration can insert or update pages.

Existing pages are fixed commitments. Only event pages recorded as created by this installation can be moved or removed through the planner, and each change still needs approval. Changes made directly in Notion are read back on refresh while the app runs. Removing a planned event directly in Notion releases its allocation; the planner can recommend replacement work for review.

If an event creation is interrupted, inspect the calendar before taking another action. Recovery lets you link the matching created event or explicitly confirm that no event was created before generating a fresh plan. The app never automatically retries an uncertain Notion create. Notion's API has no atomic compare-and-swap operation: a concurrent edit between the last version check and a write cannot be completely prevented.

References: [Notion databases in Notion Calendar](https://www.notion.com/en-us/help/use-notion-calendar-with-notion), [Notion calendar views](https://www.notion.com/help/calendars), [Google Calendar setup](GOOGLE_CALENDAR_SETUP.md).
