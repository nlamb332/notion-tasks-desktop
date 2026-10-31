import { describe, expect, it, vi } from "vitest";
import type { CalendarClient, CalendarDefinition } from "../shared/calendar";
import { cleanPlanning, DEFAULT_PLANNING } from "./planning";
import { refreshCalendarSnapshot } from "./calendar-sync";

const calendar: CalendarDefinition = { provider:"google",id:"cal",accountId:"acct",name:"Work",timeZone:"UTC",canRead:true,canWrite:true };
const remoteEvent = { ref:{calendarKey:JSON.stringify(["google","cal"]),id:"event-1"},title:"Meeting",start:"2026-11-02T15:00:00.000Z",end:"2026-11-02T16:00:00.000Z",version:"v1" };
function client(readEvents: CalendarClient["readEvents"]): CalendarClient {
  return { readEvents, getEvent: vi.fn(async()=>null), createEvent:vi.fn(async()=>remoteEvent),updateEvent:vi.fn(async()=>remoteEvent),deleteEvent:vi.fn(async()=>undefined) };
}
function planning() { return { ...structuredClone(DEFAULT_PLANNING), calendarSync:{ ...DEFAULT_PLANNING.calendarSync!,calendars:[calendar],selectedKeys:[JSON.stringify(["google","cal"])],defaultDestinationKey:null,mode:"live" as const,installationId:"install" } }; }
const range={start:"2026-11-02T00:00:00.000Z",end:"2026-11-09T00:00:00.000Z"};

describe("calendar refresh orchestration",()=>{
  it("replaces the live snapshot atomically and does not stale a plan when nothing changed",async()=>{
    const data=planning();const provider=client(async()=>[remoteEvent]);
    const first=await refreshCalendarSnapshot(data,{google:provider},range,"2026-11-02T14:00:00.000Z");
    const second=await refreshCalendarSnapshot(first.planning,{google:provider},range,"2026-11-02T14:01:00.000Z");
    expect(first.planning.events).toHaveLength(1);expect(second.planning.inputRevision).toBe(first.planning.inputRevision);
  });
  it("retains the prior snapshot when one selected provider fails",async()=>{
    const data=planning();data.events=[{id:"old",title:"Prior",start:remoteEvent.start,end:remoteEvent.end}];
    const provider=client(async()=>{throw new Error("offline")});
    await expect(refreshCalendarSnapshot(data,{google:provider},range)).rejects.toThrow("offline");
    expect(data.events[0].id).toBe("old");
  });
  it("rejects selections whose calendar definition disappeared",async()=>{
    const data=planning();data.calendarSync!.calendars=[];
    await expect(refreshCalendarSnapshot(data,{google:client(async()=>[])},range)).rejects.toThrow(/no longer available/i);
  });
  it("detaches a mapped allocation when its ownership marker was removed",async()=>{
    const data=planning();data.blocks=[{id:"block",ref:{provider:"notion",sourceId:"db",taskId:"task"},start:remoteEvent.start,end:remoteEvent.end,approvedAt:"2026-10-30T00:00:00.000Z",remote:{provider:"google",accountId:"acct",calendarId:"cal",eventId:"event-1",version:"v1"}}];
    const provider=client(async()=>[remoteEvent]);provider.getEvent=vi.fn(async()=>({...remoteEvent,ownership:undefined}));
    const result=await refreshCalendarSnapshot(data,{google:provider},range);
    expect(result.planning.blocks).toHaveLength(0);expect(result.planning.events[0].ownership).toBeUndefined();
  });
  it("normalizes an interrupted create and closes later unattempted steps after restart",()=>{
    const data=planning();data.calendarSync!.journal=[{id:"operation",proposalId:"proposal",status:"in-progress",updatedAt:"2026-11-02T00:00:00Z",steps:[
      {kind:"create",blockId:"uncertain",status:"in-progress",calendarKey:JSON.stringify(["google","cal"]),start:remoteEvent.start,end:remoteEvent.end,title:"Uncertain",taskRef:{provider:"notion",sourceId:"db",taskId:"task"}},
      {kind:"create",blockId:"not-attempted",status:"pending",calendarKey:JSON.stringify(["google","cal"]),start:remoteEvent.start,end:remoteEvent.end,title:"Later",taskRef:{provider:"notion",sourceId:"db",taskId:"other"}},
    ]}];
    const normalized=cleanPlanning(data).calendarSync!;
    expect(normalized.journal[0].status).toBe("recovery-needed");
    expect(normalized.journal[0].steps.map(step=>step.status)).toEqual(["recovery-needed","absent-confirmed"]);
  });
});
