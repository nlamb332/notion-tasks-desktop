import { DateTime, Interval } from "luxon";
import type { AppState, CalendarEvent, OwnedBlock, PlanProposal, PlanningData, SourceProvider, Task, TaskRef } from "../shared/types";

export const MAX_ESTIMATE_MINUTES = 100_000;
export const DEFAULT_PLANNING: PlanningData = {
  tasks: [], events: [], calendarImportedAt: null, calendarSource: null, operations: [],
  settings: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", workdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17, allowEmptyCalendar: false },
  blocks: [], inputRevision: 0,
};
export function refKey(ref: TaskRef): string { return JSON.stringify([ref.provider, ref.sourceId, ref.taskId]); }
export function providerFor(sourceId: string, state: AppState): SourceProvider { return state.sources.find(s => s.id === sourceId)?.provider === "plane" ? "plane" : "notion"; }
function taskRef(task: Task, state: AppState): TaskRef { return { provider: providerFor(task.sourceId, state), sourceId: task.sourceId, taskId: task.id }; }
function mins(start: string, end: string): number { return Math.max(0, Math.round(DateTime.fromISO(end).diff(DateTime.fromISO(start), "minutes").minutes)); }
function validZone(zone: string): boolean { return DateTime.now().setZone(zone).isValid; }
function taskDeadline(task: Task | undefined, timezone: string): DateTime | null {
  const raw=task?.due?.end??task?.due?.start;if(!raw)return null;
  const dt=DateTime.fromISO(raw,{zone:task?.due?.time_zone||timezone});if(!dt.isValid)return null;
  return /^\d{4}-\d\d-\d\d$/.test(raw)?dt.endOf("day"):dt;
}

export function cleanPlanning(value: unknown): PlanningData {
  const d = value && typeof value === "object" ? value as Partial<PlanningData> : {};
  const tasks = Array.isArray(d.tasks) ? d.tasks.filter(x => x && x.ref && typeof x.ref.taskId === "string" && typeof x.ref.sourceId === "string" && (x.estimateMinutes === null || Number.isInteger(x.estimateMinutes) && x.estimateMinutes > 0 && x.estimateMinutes <= MAX_ESTIMATE_MINUTES)).map(x => ({ ...x, selected: x.selected !== false, parent: x.parent ?? null, stepOrder: Number.isInteger(x.stepOrder) && x.stepOrder >= 0 ? x.stepOrder : 0 })) : [];
  const events = Array.isArray(d.events) ? d.events.filter(e => e && typeof e.id === "string" && typeof e.title === "string" && typeof e.start === "string" && typeof e.end === "string" && DateTime.fromISO(e.start).isValid && DateTime.fromISO(e.end).isValid && DateTime.fromISO(e.start) < DateTime.fromISO(e.end)) : [];
  const settings = { ...DEFAULT_PLANNING.settings, ...(d.settings || {}) };
  if (!validZone(settings.timezone)) settings.timezone = DEFAULT_PLANNING.settings.timezone;
  if (!Array.isArray(settings.workdays) || settings.workdays.some(day=>!Number.isInteger(day)||day<1||day>7)) settings.workdays=[...DEFAULT_PLANNING.settings.workdays];
  else settings.workdays=[...new Set(settings.workdays)];
  if (!Number.isInteger(settings.startHour)||settings.startHour<0||settings.startHour>23) settings.startHour=DEFAULT_PLANNING.settings.startHour;
  if (!Number.isInteger(settings.endHour)||settings.endHour<1||settings.endHour>24) settings.endHour=DEFAULT_PLANNING.settings.endHour;
  if(settings.startHour>=settings.endHour){settings.startHour=DEFAULT_PLANNING.settings.startHour;settings.endHour=DEFAULT_PLANNING.settings.endHour;}
  if(typeof settings.allowEmptyCalendar!=="boolean")settings.allowEmptyCalendar=false;
  const blocks = Array.isArray(d.blocks) ? d.blocks.filter(b => b && typeof b.id === "string" && typeof b.start === "string" && typeof b.end === "string" && DateTime.fromISO(b.start).isValid && DateTime.fromISO(b.end).isValid && DateTime.fromISO(b.start) < DateTime.fromISO(b.end)) : [];
  const operations = Array.isArray(d.operations) ? d.operations.filter(o=>o&&typeof o.id==="string"&&o.parent&&typeof o.parent.taskId==="string"&&typeof o.parent.sourceId==="string"&&Array.isArray(o.steps)&&["in-progress","complete","recovery-needed"].includes(o.status)).map(o=>({...o,steps:o.steps.filter(s=>s&&typeof s.name==="string"&&Number.isInteger(s.estimateMinutes)&&s.estimateMinutes>0&&Number.isInteger(s.order)&&["pending","creating","created","failed","recovery-needed"].includes(s.status)).map(s=>({...s,ref:s.ref&&typeof s.ref.taskId==="string"&&typeof s.ref.sourceId==="string"?s.ref:undefined,message:typeof s.message==="string"?s.message:undefined}))})) : [];
  return { tasks, events, blocks, settings, operations, calendarImportedAt: typeof d.calendarImportedAt === "string" ? d.calendarImportedAt : null, calendarSource: d.calendarSource === "ics" || d.calendarSource === "manual" ? d.calendarSource : null, inputRevision: Number.isInteger(d.inputRevision) && d.inputRevision! >= 0 ? d.inputRevision! : 0 };
}

export function setEstimate(data: PlanningData, ref: TaskRef, minutes: number | null): PlanningData {
  if (minutes !== null && (!Number.isInteger(minutes) || minutes <= 0 || minutes > MAX_ESTIMATE_MINUTES)) throw new TypeError(`Estimate must be a whole number from 1 to ${MAX_ESTIMATE_MINUTES} minutes, or Unknown.`);
  const key = refKey(ref); const old = data.tasks.find(x => refKey(x.ref) === key);
  return { ...data, inputRevision: data.inputRevision + 1, tasks: old ? data.tasks.map(x => refKey(x.ref) === key ? { ...x, estimateMinutes: minutes, selected: true } : x) : [...data.tasks, { ref, estimateMinutes: minutes, parent: null, stepOrder: 0, selected: true }] };
}

export function linkChildren(data: PlanningData, parent: TaskRef, children: { ref: TaskRef; estimateMinutes: number; order: number }[]): PlanningData {
  const parentKey = refKey(parent); if (!children.length) throw new Error("Add at least one child task.");
  const keys = new Set<string>(); const orders = new Set<number>();
  for (const child of children) {
    const key = refKey(child.ref);
    if (key === parentKey || keys.has(key) || !Number.isInteger(child.estimateMinutes) || child.estimateMinutes <= 0 || child.estimateMinutes > MAX_ESTIMATE_MINUTES || !Number.isInteger(child.order) || child.order < 0 || orders.has(child.order)) throw new Error("Breakdown contains an invalid or repeated child.");
    keys.add(key);
    orders.add(child.order);
    if (data.tasks.some(t => refKey(t.ref) === key && t.parent && refKey(t.parent) !== parentKey)) throw new Error("A task can have only one breakdown parent.");
    let cursor: TaskRef | null = parent;
    while (cursor) { if (refKey(cursor) === key) throw new Error("Breakdown would create a cycle."); cursor = data.tasks.find(t => refKey(t.ref) === refKey(cursor!))?.parent ?? null; }
  }
  const tasks = data.tasks.filter(t => !keys.has(refKey(t.ref)));
  tasks.push(...children.map(c => ({ ref: c.ref, estimateMinutes: c.estimateMinutes, parent, stepOrder: c.order, selected: true })));
  if (!tasks.some(t => refKey(t.ref) === parentKey)) tasks.push({ ref: parent, estimateMinutes: null, parent: null, stepOrder: 0, selected: true });
  return { ...data, tasks, inputRevision: data.inputRevision + 1 };
}

function estimateFor(ref: TaskRef, data: PlanningData, state: AppState, visiting = new Set<string>()): { total: number | null; remaining: number | null; leafRefs: TaskRef[] } {
  const key = refKey(ref); if (visiting.has(key)) return { total: null, remaining: null, leafRefs: [] }; visiting.add(key);
  const children = data.tasks.filter(x => x.parent && refKey(x.parent) === key);
  if (!children.length) {
    const row = data.tasks.find(x => refKey(x.ref) === key); const task = state.tasks.find(t => t.id === ref.taskId && t.sourceId === ref.sourceId);
    return { total: row?.estimateMinutes ?? null, remaining: task?.completed ? 0 : row?.estimateMinutes ?? null, leafRefs: [ref] };
  }
  const values = children.map(c => estimateFor(c.ref, data, state, new Set(visiting)));
  const total = values.every(x => x.total !== null) ? values.reduce((n,x)=>n + (x.total || 0),0) : null;
  const remaining = values.every(x => x.remaining !== null) ? values.reduce((n,x)=>n + (x.remaining || 0),0) : null;
  return { total, remaining, leafRefs: values.flatMap(x=>x.leafRefs) };
}
export function rollup(ref: TaskRef, data: PlanningData, state: AppState) { return estimateFor(ref,data,state); }

export function generatePlan(data: PlanningData, state: AppState, now = DateTime.now().setZone(data.settings.timezone)): PlanProposal {
  const { timezone, workdays, startHour, endHour } = data.settings;
  if (!validZone(timezone) || startHour < 0 || endHour > 24 || startHour >= endHour) throw new Error("Set a valid timezone and working hours first.");
  if (data.calendarSource!=="ics" && !data.settings.allowEmptyCalendar) throw new Error("Import a calendar snapshot or explicitly choose to plan against an empty calendar. Manual commitments alone do not confirm that the calendar snapshot is complete.");
  const horizonStart = now.startOf("day");
  const removals: PlanProposal["removals"] = data.blocks.filter(b=>DateTime.fromISO(b.start)>now.toUTC()).flatMap(b=>{const task=state.tasks.find(t=>t.id===b.ref.taskId&&t.sourceId===b.ref.sourceId);return !task?[{blockId:b.id,ref:b.ref,reason:"Task is no longer available; review this block"}]:task.completed?[{blockId:b.id,ref:b.ref,reason:"Task is completed; remove its future block"}]:[];});
  const fixed = data.events.map(e => ({event:e,interval:Interval.fromDateTimes(DateTime.fromISO(e.start).toUTC(), DateTime.fromISO(e.end).toUTC())}));
  const movable = data.blocks.filter(b=>DateTime.fromISO(b.start)>now.toUTC()&&DateTime.fromISO(b.start)<horizonStart.plus({days:7}).toUTC()&&state.tasks.some(t=>t.id===b.ref.taskId&&t.sourceId===b.ref.sourceId&&!t.completed));
  const conflicts = new Set(movable.filter(b=>fixed.some(f=>{const block=Interval.fromDateTimes(DateTime.fromISO(b.start).toUTC(),DateTime.fromISO(b.end).toUTC());const isOwnCopy=f.event.id===`${b.id}@notion-tasks.local`&&f.interval.start!.toMillis()===block.start!.toMillis()&&f.interval.end!.toMillis()===block.end!.toMillis();return !isOwnCopy&&block.overlaps(f.interval);})).map(b=>b.id));
  const busy: Interval[] = [...fixed.map(x=>x.interval), ...data.blocks.filter(b=>DateTime.fromISO(b.end)>now.toUTC()&&!conflicts.has(b.id)).map(b=>Interval.fromDateTimes(DateTime.fromISO(b.start).toUTC(),DateTime.fromISO(b.end).toUTC()))];
  const gaps: Interval[] = [];
  for (let i=0;i<7;i++) { const day=horizonStart.plus({days:i}); if (!workdays.includes(day.weekday)) continue; const start=day.set({hour:startHour,minute:0,second:0,millisecond:0}); const end=day.set({hour:endHour,minute:0,second:0,millisecond:0}); const actualStart=i===0 && now>start ? now : start; if (end<=actualStart) continue; let cursor=actualStart.toUTC(); const bounds=Interval.fromDateTimes(actualStart.toUTC(),end.toUTC());
    const cuts=busy.filter(x=>x.overlaps(bounds)).sort((a,b)=>a.start!.toMillis()-b.start!.toMillis()); for(const cut of cuts){if(cut.start!>cursor) gaps.push(Interval.fromDateTimes(cursor,cut.start!)); if(cut.end!>cursor) cursor=cut.end!;} if(cursor<end.toUTC()) gaps.push(Interval.fromDateTimes(cursor,end.toUTC())); }
  const totalCapacityMinutes=gaps.reduce((n,g)=>n+Math.floor(g.length("minutes")),0);
  const moves: PlanProposal["moves"]=[];
  const orderedConflicts=movable.filter(b=>conflicts.has(b.id)).sort((a,b)=>DateTime.fromISO(a.start).toMillis()-DateTime.fromISO(b.start).toMillis());
  for(const block of orderedConflicts){const minutes=mins(block.start,block.end);let moved=false;for(let i=0;i<gaps.length;i++){const gap=gaps[i];if(Math.floor(gap.length("minutes"))<minutes)continue;const start=gap.start!,end=start.plus({minutes});moves.push({blockId:block.id,ref:block.ref,start:start.toISO()!,end:end.toISO()!,minutes,reason:"Fixed calendar event overlaps this approved block; proposed move requires approval"});const preserve:Interval[]=[];if(end<gap.end!)preserve.push(Interval.fromDateTimes(end,gap.end!));gaps.splice(i,1,...preserve);moved=true;break;}if(!moved)moves.push({blockId:block.id,ref:block.ref,start:"",end:"",minutes,reason:"Fixed calendar event conflicts with this block; no fitting replacement is available"});}
  const parents = data.tasks.filter(x=>!x.parent && x.selected).map(x=>x.ref);
  const unscheduled: PlanProposal["unscheduled"] = [];
  const rows = parents.flatMap(ref=>estimateFor(ref,data,state).leafRefs).map(ref=>({ref,task:state.tasks.find(t=>t.id===ref.taskId&&t.sourceId===ref.sourceId),row:data.tasks.find(x=>refKey(x.ref)===refKey(ref)),info:estimateFor(ref,data,state)})).filter(x=>x.task&&!x.task.completed);
  const unique = [...new Map(rows.map(x=>[refKey(x.ref),x])).values()];
  for(const row of data.tasks.filter(x=>!x.parent&&x.selected)){const leaves=estimateFor(row.ref,data,state).leafRefs;for(const ref of leaves){if(!state.tasks.some(t=>t.id===ref.taskId&&t.sourceId===ref.sourceId)&&!unscheduled.some(x=>refKey(x.ref)===refKey(ref)))unscheduled.push({ref,reason:"Task is no longer available; review its estimate and links",minutes:data.tasks.find(x=>refKey(x.ref)===refKey(ref))?.estimateMinutes??null});}}
  const futureAllocated=new Map<string,number>(); for(const b of data.blocks){if(DateTime.fromISO(b.end)>now.toUTC()){const k=refKey(b.ref);futureAllocated.set(k,(futureAllocated.get(k)||0)+mins(b.start,b.end));}}
  unique.sort((a,b)=> { const ap=a.row?.parent,bp=b.row?.parent;if(ap&&bp&&refKey(ap)===refKey(bp)&&a.row!.stepOrder!==b.row!.stepOrder)return a.row!.stepOrder-b.row!.stepOrder; const ad=taskDeadline(a.task,timezone)?.toMillis()??Infinity; const bd=taskDeadline(b.task,timezone)?.toMillis()??Infinity; return (ad<now.toMillis()?-1:0)-(bd<now.toMillis()?-1:0)||ad-bd||Number(state.stars.includes(b.task!.id))-Number(state.stars.includes(a.task!.id))||refKey(a.ref).localeCompare(refKey(b.ref)); });
  const breakdownReadyAt=new Map<string,DateTime>();const processedBreakdownTasks=new Set<string>();const blockedBreakdowns=new Set<string>();
  const items: PlanProposal["items"]=[]; let allocatedMinutes=0;
  for(const row of unique){const parent=row.row?.parent;const parentKey=parent?refKey(parent):"";const sourceAvailable=state.sources.some(s=>s.id===row.ref.sourceId)&&state.sync.onlineSources.includes(row.ref.sourceId);if(!sourceAvailable){unscheduled.push({ref:row.ref,reason:"Source is offline or unavailable; refresh before planning",minutes:row.row?.estimateMinutes??null});if(parent)blockedBreakdowns.add(parentKey);processedBreakdownTasks.add(refKey(row.ref));continue;} if(parent){const predecessors=data.tasks.filter(x=>x.parent&&refKey(x.parent)===parentKey&&x.stepOrder<row.row!.stepOrder).sort((a,b)=>a.stepOrder-b.stepOrder);let blocked=blockedBreakdowns.has(parentKey);for(const prior of predecessors){const priorKey=refKey(prior.ref);const priorTask=state.tasks.find(t=>t.id===prior.ref.taskId&&t.sourceId===prior.ref.sourceId);if(priorTask?.completed)continue;if(!processedBreakdownTasks.has(priorKey)){blocked=true;break;}const ready=breakdownReadyAt.get(priorKey);if(!ready){blocked=true;break;}const current=breakdownReadyAt.get(parentKey);if(!current||ready>current)breakdownReadyAt.set(parentKey,ready);}if(blocked){unscheduled.push({ref:row.ref,reason:"Prerequisite step is unknown or cannot fit",minutes:row.row?.estimateMinutes??null});blockedBreakdowns.add(parentKey);processedBreakdownTasks.add(refKey(row.ref));continue;}}
    const estimate=row.row?.estimateMinutes ?? null; const remaining=estimate===null?null:Math.max(0,estimate-(futureAllocated.get(refKey(row.ref))||0)); if(remaining===null){unscheduled.push({ref:row.ref,reason:"No estimate",minutes:null});if(parent)blockedBreakdowns.add(parentKey);processedBreakdownTasks.add(refKey(row.ref));continue;} if(remaining===0){const ends=data.blocks.filter(b=>refKey(b.ref)===refKey(row.ref)&&DateTime.fromISO(b.end)>now.toUTC()).map(b=>DateTime.fromISO(b.end).toUTC());if(ends.length)breakdownReadyAt.set(refKey(row.ref),ends.reduce((a,b)=>a>b?a:b));processedBreakdownTasks.add(refKey(row.ref));continue;} const due=taskDeadline(row.task,timezone); let minutes=remaining; let placed=false;const ready=parent?breakdownReadyAt.get(parentKey):undefined;
    for(let i=0;i<gaps.length;i++){const gap=gaps[i]; const start=ready&&ready>gap.start!?ready:gap.start!;const overdue=Boolean(due&&due<now);const cutoff=due&&!overdue?DateTime.min(gap.end!,due.toUTC()):gap.end!; if(cutoff<=start)continue; if(Math.floor(cutoff.diff(start,"minutes").minutes)<minutes)continue; const end=start.plus({minutes}); items.push({ref:row.ref,start:start.toISO()!,end:end.toISO()!,minutes,reason:overdue?"Overdue work; approval required":"Fits available working time"}); allocatedMinutes+=minutes;const preserve:Interval[]=[];if(gap.start!<start)preserve.push(Interval.fromDateTimes(gap.start!,start));if(end<gap.end!)preserve.push(Interval.fromDateTimes(end,gap.end!));gaps.splice(i,1,...preserve);placed=true;break;}
    if(placed){const item=items.at(-1)!;if(parent)breakdownReadyAt.set(refKey(row.ref),DateTime.fromISO(item.end).toUTC());}else{const deadlineMiss=Boolean(due&&due>=now&&gaps.some(g=>g.start!>due&&Math.floor(g.length("minutes"))>=minutes));unscheduled.push({ref:row.ref,reason:due&&due<now?"Overdue; no fitting time in the horizon":deadlineMiss?"Deadline cannot be met in the available working time":"No fitting gap in the next seven days",minutes});if(parent)blockedBreakdowns.add(parentKey);}processedBreakdownTasks.add(refKey(row.ref)); }
  return {id:`plan-${Date.now()}-${data.inputRevision}`,inputRevision:data.inputRevision,generatedAt:now.toUTC().toISO()!,items,moves,removals,unscheduled,capacityMinutes:totalCapacityMinutes,allocatedMinutes:allocatedMinutes+moves.filter(m=>m.start).reduce((n,m)=>n+m.minutes,0)};
}

export function approvePlan(data: PlanningData, state: AppState, proposal: PlanProposal, selected: string[], approvalNow = DateTime.now().setZone(data.settings.timezone)): PlanningData {
  const chosen=new Set(selected); const requested=proposal.items.filter(x=>chosen.has(refKey(x.ref))); const requestedMoves=proposal.moves.filter(x=>x.start&&chosen.has(`move:${x.blockId}`)); const requestedRemovals=proposal.removals.filter(x=>chosen.has(`remove:${x.blockId}`));
  const requestedIds=requested.map(x=>`${proposal.id}-${encodeURIComponent(refKey(x.ref))}-${DateTime.fromISO(x.start).toMillis()}`);
  if((requestedIds.length+requestedRemovals.length+requestedMoves.length)>0&&requestedIds.every(id=>data.blocks.some(b=>b.id===id))&&requestedRemovals.every(r=>!data.blocks.some(b=>b.id===r.blockId))&&requestedMoves.every(m=>data.blocks.some(b=>b.id===m.blockId&&b.start===m.start&&b.end===m.end)))return data;
  if(proposal.inputRevision!==data.inputRevision) throw new Error("This plan is stale. Generate a fresh review before approving.");
  const generatedAt=DateTime.fromISO(proposal.generatedAt).setZone(data.settings.timezone); if(!generatedAt.isValid)throw new Error("Plan timestamp is invalid.");
  if(generatedAt.startOf("day").toMillis()!==approvalNow.setZone(data.settings.timezone).startOf("day").toMillis()||requested.some(x=>DateTime.fromISO(x.start)<=approvalNow.toUTC())||requestedMoves.some(x=>DateTime.fromISO(x.start)<=approvalNow.toUTC())||requestedRemovals.some(x=>{const block=data.blocks.find(b=>b.id===x.blockId);return !block||DateTime.fromISO(block.start)<=approvalNow.toUTC();}))throw new Error("This plan is stale because time has passed or the local date changed. Generate a fresh review.");
  const fresh=generatePlan(data,state,generatedAt); if(fresh.items.length!==proposal.items.length || fresh.items.some((item,i)=>refKey(item.ref)!==refKey(proposal.items[i]?.ref)||item.start!==proposal.items[i]?.start||item.end!==proposal.items[i]?.end)||fresh.moves.length!==proposal.moves.length||fresh.moves.some((item,i)=>item.blockId!==proposal.moves[i]?.blockId||item.start!==proposal.moves[i]?.start||item.end!==proposal.moves[i]?.end)||fresh.removals.length!==proposal.removals.length||fresh.removals.some((item,i)=>item.blockId!==proposal.removals[i]?.blockId||item.reason!==proposal.removals[i]?.reason)) throw new Error("Planning inputs changed. Generate a fresh review before approving.");
  const additions=requested.map(x=>({id:`${proposal.id}-${encodeURIComponent(refKey(x.ref))}-${DateTime.fromISO(x.start).toMillis()}`,ref:x.ref,start:x.start,end:x.end,approvedAt:new Date().toISOString()}));
  const removed=new Set([...requestedRemovals.map(x=>x.blockId),...requestedMoves.map(x=>x.blockId)]);
  const moved:OwnedBlock[]=requestedMoves.map(m=>({id:m.blockId,ref:m.ref,start:m.start,end:m.end,approvedAt:new Date().toISOString()}));
  return { ...data, blocks:[...data.blocks.filter(b=>!removed.has(b.id)),...moved,...additions.filter(x=>!data.blocks.some(b=>b.id===x.id))] };
}

function unfold(text:string):string[] { return text.replace(/\r?\n[ \t]/g,"").split(/\r?\n/); }
export function parseCalendarICS(ics:string, timezone:string):{events:CalendarEvent[]; importedAt:string} {
  if(!validZone(timezone))throw new Error("Choose a valid IANA timezone before importing.");
  if(/\b(?:RRULE|RDATE|EXDATE|RECURRENCE-ID)\s*:/i.test(ics))throw new Error("Recurring calendar events are not supported yet. Export a non-recurring seven-day snapshot and import that file.");
  const blocks=ics.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)||[]; if(!/BEGIN:VCALENDAR/.test(ics)||!blocks.length)throw new Error("This file has no calendar events."); if(/BEGIN:VTIMEZONE/i.test(ics))throw new Error("This calendar uses custom timezone definitions that are not supported yet. Export events with UTC times or without embedded timezone definitions."); if(/BEGIN:VFREEBUSY/i.test(ics))throw new Error("This calendar contains VFREEBUSY records, which are not supported. Export the busy periods as individual events."); if((ics.match(/BEGIN:VEVENT/g)||[]).length!==blocks.length||(ics.match(/END:VEVENT/g)||[]).length!==blocks.length)throw new Error("The calendar has an incomplete event record; no events were imported.");
  const events:CalendarEvent[]=[];const uids=new Set<string>();
  for(const block of blocks){const get=(key:string)=>unfold(block).find(l=>l.startsWith(`${key};`)||l.startsWith(`${key}:`))||""; const uid=get("UID").split(":").slice(1).join(":")||`event-${events.length}`; if(uids.has(uid))throw new Error(`This calendar repeats event UID “${uid}”; export a de-duplicated snapshot.`);uids.add(uid); const status=get("STATUS").split(":").pop(); if(status==="CANCELLED")continue; const transparency=get("TRANSP").split(":").pop(); if(transparency==="TRANSPARENT")continue;
    const parse=(line:string)=>{const [head,value]=line.split(/:(.*)/s);if(!value)throw new Error("An event is missing a start or end time."); const allDay=/VALUE=DATE/.test(head); const tz=head.match(/TZID=([^;:]+)/i)?.[1]??timezone;if(!validZone(tz))throw new Error(`Unsupported event timezone “${tz}”. Choose an export using valid IANA timezones.`); let dt:DateTime; if(allDay){dt=DateTime.fromFormat(value.slice(0,8),"yyyyMMdd",{zone:tz}).startOf("day");}else if(/Z$/.test(value))dt=DateTime.fromFormat(value,"yyyyMMdd'T'HHmmss'Z'",{zone:"utc"});else if(/T/.test(value))dt=DateTime.fromFormat(value,"yyyyMMdd'T'HHmmss",{zone:tz});else throw new Error("Unsupported event date format.");if(!dt.isValid)throw new Error("An event has an invalid date/time.");return dt.toUTC().toISO()!;};
    const start=parse(get("DTSTART")); const end=parse(get("DTEND")); if(DateTime.fromISO(start)>=DateTime.fromISO(end))throw new Error("An event ends before it starts."); const summary=get("SUMMARY").split(":").slice(1).join(":").replace(/\\n/g," ").replace(/\\,/g,",").replace(/\\;/g,";"); events.push({id:uid,title:summary||"Busy",start,end,allDay:/VALUE=DATE/.test(get("DTSTART"))}); }
  return {events,importedAt:new Date().toISOString()};
}
export function exportApprovedICS(blocks:OwnedBlock[],state:AppState):string { const stamp=(v:string)=>DateTime.fromISO(v).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'"); return ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Notion Tasks//Local plan//EN",...blocks.flatMap(b=>{const t=state.tasks.find(x=>x.id===b.ref.taskId&&x.sourceId===b.ref.sourceId);return ["BEGIN:VEVENT",`UID:${b.id}@notion-tasks.local`,`DTSTAMP:${stamp(b.approvedAt)}`,`DTSTART:${stamp(b.start)}`,`DTEND:${stamp(b.end)}`,`SUMMARY:${(t?.name||"Planned task").replace(/[\\,;]/g,"\\$&")}`,"END:VEVENT"]}),"END:VCALENDAR",""].join("\r\n"); }
