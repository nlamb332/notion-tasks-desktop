import { DateTime, Interval } from "luxon";
import type { CalendarEvent, PlanPlacement, PlanProposal, PlanningData, Task, TaskRef } from "./types";

export function refKey(ref: TaskRef): string { return JSON.stringify([ref.provider, ref.sourceId, ref.taskId]); }
export function moveKey(blockId: string): string { return `move:${blockId}`; }
export function taskDeadline(task: Task | undefined, timezone: string): DateTime | null {
  const raw=task?.due?.end??task?.due?.start;if(!raw)return null;
  const dt=DateTime.fromISO(raw,{zone:task?.due?.time_zone||timezone});if(!dt.isValid)return null;
  return /^\d{4}-\d\d-\d\d$/.test(raw)?dt.endOf("day"):dt;
}
/** Events the planner must work around: everything except the calendar copies of app-owned blocks. */
export function fixedEvents(data: PlanningData): CalendarEvent[] {
  const installationId=data.calendarSync?.installationId;
  return data.events.filter(event=>!data.blocks.some(block=>event.id===`${block.id}@notion-tasks.local`||(block.remote&&event.remote?.provider===block.remote.provider&&event.remote?.accountId===block.remote.accountId&&event.remote?.calendarId===block.remote.calendarId&&event.remote?.eventId===block.remote.eventId&&event.ownership?.installationId===installationId&&event.ownership?.blockId===block.id)));
}

/** Only a key and start are accepted, so a placement cannot change a task link or its duration. */
export function applyPlacements(proposal: PlanProposal, placements: PlanPlacement[]): PlanProposal {
  const byKey=new Map(placements.map(placement=>[placement.key,placement.start]));
  if(byKey.size!==placements.length)throw new Error("A proposed block was moved more than once. Review the current proposal and try again.");
  const known=new Set([...proposal.items.map(item=>refKey(item.ref)),...proposal.moves.filter(move=>move.start).map(move=>moveKey(move.blockId))]);
  for(const [key,start] of byKey)if(!known.has(key)||!DateTime.fromISO(start).isValid)throw new Error("A moved block is invalid. Review the current proposal and try again.");
  const place=<T extends {start:string;end:string;minutes:number}>(entry:T,key:string):T=>{const start=byKey.get(key);if(!start)return entry;const utc=DateTime.fromISO(start).toUTC();return {...entry,start:utc.toISO()!,end:utc.plus({minutes:entry.minutes}).toISO()!};};
  return {...proposal,items:proposal.items.map(item=>place(item,refKey(item.ref))),moves:proposal.moves.map(move=>move.start?place(move,moveKey(move.blockId)):move)};
}

export interface PlacementContext { data: PlanningData; tasks: Task[]; proposal: PlanProposal; selected: string[]; now: DateTime }

function nameOf(ref: TaskRef, tasks: Task[]): string { return tasks.find(task=>task.id===ref.taskId&&task.sourceId===ref.sourceId)?.name||"another task"; }
function span(start: string, end: string): Interval { return Interval.fromDateTimes(DateTime.fromISO(start).toUTC(),DateTime.fromISO(end).toUTC()); }

/** Returns why a proposed block cannot sit at its current time, or null when it fits. */
export function placementConflict(key: string, { data, tasks, proposal, selected, now }: PlacementContext): string | null {
  const { timezone, workdays, startHour, endHour } = data.settings;
  const chosen=new Set(selected);
  const entries=[...proposal.items.map(item=>({key:refKey(item.ref),ref:item.ref,blockId:null as string|null,start:item.start,end:item.end})),...proposal.moves.filter(move=>move.start).map(move=>({key:moveKey(move.blockId),ref:move.ref,blockId:move.blockId as string|null,start:move.start,end:move.end}))];
  const entry=entries.find(candidate=>candidate.key===key);if(!entry)return "This block is no longer in the proposal.";
  const start=DateTime.fromISO(entry.start).setZone(timezone),end=DateTime.fromISO(entry.end).setZone(timezone),interval=span(entry.start,entry.end);
  const firstDay=DateTime.fromISO(proposal.generatedAt).setZone(timezone).startOf("day");
  if(start<firstDay||start>=firstDay.plus({days:7}))return "Choose a time within the seven planning dates.";
  if(start<=now)return "That time has already passed.";
  if(!workdays.includes(start.weekday))return `${start.toFormat("cccc")} is not a working day.`;
  if(start<start.set({hour:startHour,minute:0,second:0,millisecond:0})||!end.hasSame(start,"day")&&!(endHour===24&&end.equals(start.startOf("day").plus({days:1})))||end>start.startOf("day").set({hour:endHour===24?23:endHour,minute:endHour===24?59:0,second:endHour===24?59:0,millisecond:endHour===24?999:0}).plus({milliseconds:endHour===24?1:0}))return `That is outside working hours (${startHour}:00–${endHour}:00).`;
  const task=tasks.find(item=>item.id===entry.ref.taskId&&item.sourceId===entry.ref.sourceId);
  const due=taskDeadline(task,timezone);if(due&&due>=firstDay&&end>due)return "That ends after the task's deadline.";
  const event=fixedEvents(data).find(candidate=>interval.overlaps(span(candidate.start,candidate.end)));if(event)return `That overlaps ${event.title}.`;
  const movingAway=new Set(proposal.moves.filter(move=>move.start&&chosen.has(moveKey(move.blockId))).map(move=>move.blockId));
  const retained=data.blocks.filter(block=>block.id!==entry.blockId&&!movingAway.has(block.id)&&DateTime.fromISO(block.end).toUTC()>now.toUTC());
  const block=retained.find(candidate=>interval.overlaps(span(candidate.start,candidate.end)));if(block)return `That overlaps the approved block for ${nameOf(block.ref,tasks)}.`;
  const others=entries.filter(candidate=>candidate.key!==key&&chosen.has(candidate.key));
  const other=others.find(candidate=>interval.overlaps(span(candidate.start,candidate.end)));if(other)return `That overlaps the proposed block for ${nameOf(other.ref,tasks)}.`;
  const row=data.tasks.find(candidate=>refKey(candidate.ref)===refKey(entry.ref));
  if(row?.parent){const parent=refKey(row.parent);
    for(const sibling of data.tasks.filter(candidate=>candidate.parent&&refKey(candidate.parent)===parent&&refKey(candidate.ref)!==refKey(row.ref))){
      const siblingTask=tasks.find(item=>item.id===sibling.ref.taskId&&item.sourceId===sibling.ref.sourceId);if(siblingTask?.completed)continue;
      const scheduled=[...others,...retained].filter(candidate=>refKey(candidate.ref)===refKey(sibling.ref));
      if(sibling.stepOrder<row.stepOrder&&scheduled.some(candidate=>DateTime.fromISO(candidate.end).toUTC()>interval.start!))return `${nameOf(sibling.ref,tasks)} must finish first.`;
      if(sibling.stepOrder>row.stepOrder&&scheduled.some(candidate=>DateTime.fromISO(candidate.start).toUTC()<interval.end!))return `This must finish before ${nameOf(sibling.ref,tasks)}.`;
    }
  }
  return null;
}
