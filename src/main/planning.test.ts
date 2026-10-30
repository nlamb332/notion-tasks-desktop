import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { AppState, TaskRef } from "../shared/types";
import { approvePlan, DEFAULT_PLANNING, generatePlan, linkChildren, parseCalendarICS, rollup, setEstimate } from "./planning";

const ref=(taskId:string):TaskRef=>({provider:"notion",sourceId:"db",taskId});
function state(tasks:AppState["tasks"]):AppState{return {connected:true,sources:[{id:"db",databaseId:"db",name:"Tasks",properties:[],mapping:{title:"t",due:null,status:"s",complete:"Done",reopen:"Todo"}}],tasks,stars:[],settings:{compact:false,alwaysOnTop:false,launchAtLogin:false,selectedList:"all",lastSourceId:"db"},sync:{syncing:false,lastSync:null,errors:{},onlineSources:["db"]},planning:{...DEFAULT_PLANNING,settings:{...DEFAULT_PLANNING.settings,timezone:"America/Chicago"}}};}
const task=(id:string,completed=false,due:AppState["tasks"][number]["due"]=null):AppState["tasks"][number]=>({id,sourceId:"db",name:id,url:"",due,status:completed?"Done":"Todo",completed,lastEdited:"2026-01-01T00:00:00.000Z"});

describe("rolling calendar planning",()=>{
  it("places an estimate in the gap between fixed events",()=>{
    const s=state([task("a")]);const date="2026-11-02";
    let d=setEstimate(DEFAULT_PLANNING,ref("a"),60);d={...d,calendarImportedAt:"2026-10-30T00:00:00.000Z",calendarSource:"ics",events:[{id:"before",title:"Before",start:`${date}T15:00:00.000Z`,end:`${date}T16:00:00.000Z`},{id:"after",title:"After",start:`${date}T17:00:00.000Z`,end:`${date}T18:00:00.000Z`}]};
    const p=generatePlan(d,s,DateTime.fromISO(`${date}T14:00:00Z`).setZone("America/Chicago"));
    expect(p.items).toHaveLength(1);expect(p.items[0].minutes).toBe(60);
  });
  it("rolls up children and schedules leaves only",()=>{
    const s=state([task("parent"),task("one"),task("two")]);let d=setEstimate(DEFAULT_PLANNING,ref("parent"),null);d=linkChildren(d,ref("parent"),[{ref:ref("one"),estimateMinutes:20,order:0},{ref:ref("two"),estimateMinutes:40,order:1}]);
    expect(rollup(ref("parent"),d,s)).toMatchObject({total:60,remaining:60});
    const plan=generatePlan({...d,calendarImportedAt:"2026-10-30T00:00:00Z",calendarSource:"ics"},s,DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago"));expect(plan.items.map(x=>x.ref.taskId)).toEqual(["one","two"]);
    expect(rollup(ref("parent"),d,state([task("parent"),task("one",true),task("two")]))).toMatchObject({total:60,remaining:40});
  });
  it("rejects an approval after input revision changes and is idempotent",()=>{
    const s=state([task("a")]);let d=setEstimate(DEFAULT_PLANNING,ref("a"),30);d={...d,calendarImportedAt:"2026-10-30T00:00:00Z",calendarSource:"ics"};const proposal=generatePlan(d,s,DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago"));
    expect(()=>approvePlan({...d,inputRevision:d.inputRevision+1},s,proposal,[JSON.stringify(["notion","db","a"])] )).toThrow(/stale/i);
    const asOf=DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago");const first=approvePlan(d,s,proposal,[JSON.stringify(["notion","db","a"])],asOf);const second=approvePlan(first,s,proposal,[JSON.stringify(["notion","db","a"])],asOf);expect(second.blocks).toHaveLength(1);
  });
  it("does not treat manual commitments as a complete calendar without explicit empty-calendar choice",()=>{
    const s=state([task("a")]);const d={...setEstimate(DEFAULT_PLANNING,ref("a"),30),calendarImportedAt:"manual",calendarSource:"manual" as const,events:[{id:"manual",title:"Appointment",start:"2026-11-02T15:00:00Z",end:"2026-11-02T16:00:00Z"}]};
    expect(()=>generatePlan(d,s,DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago"))).toThrow(/complete/i);
    expect(generatePlan({...d,settings:{...d.settings,allowEmptyCalendar:true}},s,DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago")).items).toHaveLength(1);
  });
  it("rejects recurrence without replacing the prior snapshot",()=>{
    const ics="BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261102T150000Z\r\nDTEND:20261102T160000Z\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(()=>parseCalendarICS(ics,"America/Chicago")).toThrow(/recurring/i);
  });
  it("blocks later breakdown steps behind an unknown predecessor",()=>{
    const s=state([task("parent"),task("step-a"),task("step-b")]);let d=setEstimate(DEFAULT_PLANNING,ref("parent"),null);d=linkChildren(d,ref("parent"),[{ref:ref("step-a"),estimateMinutes:20,order:0},{ref:ref("step-b"),estimateMinutes:30,order:1}]);d={...d,tasks:d.tasks.map(x=>x.ref.taskId==="step-a"?{...x,estimateMinutes:null}:x)};
    const p=generatePlan({...d,calendarImportedAt:"snapshot",calendarSource:"ics"},s,DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago"));
    expect(p.items).toEqual([]);expect(p.unscheduled.map(x=>x.reason)).toContain("Prerequisite step is unknown or cannot fit");
  });
  it("uses timezone-aware work windows across the spring DST transition",()=>{
    const s=state([task("long")]);let d=setEstimate(DEFAULT_PLANNING,ref("long"),150);d={...d,calendarImportedAt:"snapshot",calendarSource:"ics",settings:{...DEFAULT_PLANNING.settings,timezone:"America/Chicago",workdays:[7],startHour:1,endHour:4}};
    const p=generatePlan(d,s,DateTime.fromISO("2027-03-14T06:00:00Z").setZone("America/Chicago"));
    expect(p.capacityMinutes).toBe(120);expect(p.items).toEqual([]);expect(p.unscheduled[0].minutes).toBe(150);
  });
  it("proposes a move for a fixed-event conflict and changes the block only after approval",()=>{
    const s=state([task("a")]);let d=setEstimate(DEFAULT_PLANNING,ref("a"),30);d={...d,calendarImportedAt:"snapshot",calendarSource:"ics",events:[{id:"meeting",title:"Meeting",start:"2026-11-02T15:00:00Z",end:"2026-11-02T16:00:00Z"}],blocks:[{id:"owned",ref:ref("a"),start:"2026-11-02T15:30:00Z",end:"2026-11-02T16:00:00Z",approvedAt:"2026-10-30T00:00:00Z"}]};
    const now=DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago");const proposal=generatePlan(d,s,now);expect(proposal.moves).toHaveLength(1);expect(proposal.moves[0].start).toBe("2026-11-02T16:00:00.000Z");expect(d.blocks[0].start).toBe("2026-11-02T15:30:00Z");
    const key=`move:${proposal.moves[0].blockId}`;const approved=approvePlan(d,s,proposal,[key],now);expect(approved.blocks[0]).toMatchObject({id:"owned",start:proposal.moves[0].start,end:proposal.moves[0].end});expect(approvePlan(approved,s,proposal,[key],now)).toEqual(approved);
  });
  it("ignores cancelled and transparent fixed events and rejects malformed intervals",()=>{
    const ics="BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261102T150000Z\r\nDTEND:20261102T160000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261102T150000Z\r\nDTEND:20261102T160000Z\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(parseCalendarICS(ics,"America/Chicago").events).toEqual([]);
    const malformed=ics.replace("STATUS:CANCELLED\r\n","").replace("TRANSP:TRANSPARENT\r\n","").replace("DTEND:20261102T160000Z","DTEND:20261102T140000Z");
    expect(()=>parseCalendarICS(malformed,"America/Chicago")).toThrow(/ends before/i);
  });
  it("normalizes exclusive all-day boundaries and overnight events",()=>{
    const ics="BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:all-day\r\nDTSTART;VALUE=DATE:20261102\r\nDTEND;VALUE=DATE:20261103\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:overnight\r\nDTSTART;TZID=America/Chicago:20261102T230000\r\nDTEND;TZID=America/Chicago:20261103T010000\r\nSUMMARY:Travel\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const events=parseCalendarICS(ics,"America/Chicago").events;
    expect(events[0]).toMatchObject({allDay:true,start:"2026-11-02T06:00:00.000Z",end:"2026-11-03T06:00:00.000Z"});
    expect(DateTime.fromISO(events[1].end).diff(DateTime.fromISO(events[1].start),"hours").hours).toBe(2);
  });
});
