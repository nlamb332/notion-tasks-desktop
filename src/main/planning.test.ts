import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { AppState, PlanningData, TaskRef } from "../shared/types";
import { applyPlacements, fixedEvents, placementConflict } from "../shared/plan-placement";
import { approvePlan, cleanPlanning, DEFAULT_PLANNING as SYSTEM_DEFAULT_PLANNING, generatePlan, linkChildren, moveBlock, parseCalendarICS, restoreLocalCalendar, rollup, setEstimate, stashLocalCalendar } from "./planning";

const DEFAULT_PLANNING = { ...SYSTEM_DEFAULT_PLANNING, settings: { ...SYSTEM_DEFAULT_PLANNING.settings, timezone: "America/Chicago" } };

const ref=(taskId:string):TaskRef=>({provider:"notion",sourceId:"db",taskId});
function state(tasks:AppState["tasks"]):AppState{return {connected:true,sources:[{id:"db",databaseId:"db",name:"Tasks",properties:[],mapping:{title:"t",due:null,status:"s",complete:"Done",reopen:"Todo"}}],tasks,stars:[],settings:{compact:false,alwaysOnTop:false,launchAtLogin:false,selectedList:"all",lastSourceId:"db"},sync:{syncing:false,lastSync:null,errors:{},onlineSources:["db"]},planning:{...DEFAULT_PLANNING,settings:{...DEFAULT_PLANNING.settings,timezone:"America/Chicago"}}};}
const task=(id:string,completed=false,due:AppState["tasks"][number]["due"]=null):AppState["tasks"][number]=>({id,sourceId:"db",name:id,url:"",due,status:completed?"Done":"Todo",completed,lastEdited:"2026-01-01T00:00:00.000Z"});

describe("moving approved blocks",()=>{
  const now=DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago");
  const block=(id:string,taskId:string,start:string,end:string,remote?:PlanningData["blocks"][number]["remote"])=>({id,ref:ref(taskId),start,end,approvedAt:"2026-11-01T00:00:00.000Z",...(remote?{remote}:{})});
  const base=(blocks:PlanningData["blocks"],extra:Partial<PlanningData>={}):PlanningData=>({...DEFAULT_PLANNING,blocks,calendarSource:"ics",...extra});
  it("keeps the duration, task, and calendar link, and invalidates open drafts",()=>{
    const remote={provider:"google" as const,accountId:"a",calendarId:"c",eventId:"e",version:"1"};
    const d=base([block("b","a","2026-11-03T15:00:00.000Z","2026-11-03T15:45:00.000Z",remote)],{calendarSync:{...DEFAULT_PLANNING.calendarSync!,mode:"live"}});
    const next=moveBlock(d,state([task("a")]),"b","2026-11-04T16:00:00.000Z",now);
    expect(next.blocks[0]).toMatchObject({start:"2026-11-04T16:00:00.000Z",end:"2026-11-04T16:45:00.000Z",ref:ref("a"),remote});
    expect(next.inputRevision).toBe(d.inputRevision+1);
  });
  it("uses the same rules as proposed blocks",()=>{
    const d=base([block("b","a","2026-11-03T15:00:00.000Z","2026-11-03T16:00:00.000Z"),block("other","c","2026-11-03T18:00:00.000Z","2026-11-03T19:00:00.000Z")],{events:[{id:"meeting",title:"Meeting",start:"2026-11-04T16:00:00.000Z",end:"2026-11-04T17:00:00.000Z"}]});
    const s=state([task("a"),task("c")]);
    expect(()=>moveBlock(d,s,"b","2026-11-04T16:30:00.000Z",now)).toThrow("overlaps Meeting");
    expect(()=>moveBlock(d,s,"b","2026-11-03T18:30:00.000Z",now)).toThrow("approved block for c");
    expect(()=>moveBlock(d,s,"b","2026-11-07T16:00:00.000Z",now)).toThrow("not a working day");
    expect(()=>moveBlock(d,s,"b","2026-11-03T15:15:00.000Z",now).blocks[0].start).not.toThrow();
    const due=state([task("a",false,{start:"2026-11-03",end:null}),task("c")]);
    expect(()=>moveBlock(d,due,"b","2026-11-04T16:00:00.000Z",now)).toThrow("deadline");
  });
  it("refuses started blocks, closed tasks, and linked blocks without a live calendar",()=>{
    const s=state([task("a"),task("done",true)]);
    expect(()=>moveBlock(base([block("b","a","2026-11-02T13:00:00.000Z","2026-11-02T15:00:00.000Z")]),s,"b","2026-11-03T16:00:00.000Z",now)).toThrow("already started");
    expect(()=>moveBlock(base([block("b","done","2026-11-03T15:00:00.000Z","2026-11-03T16:00:00.000Z")]),s,"b","2026-11-03T16:00:00.000Z",now)).toThrow("completed");
    expect(()=>moveBlock(base([block("b","gone","2026-11-03T15:00:00.000Z","2026-11-03T16:00:00.000Z")]),s,"b","2026-11-03T16:00:00.000Z",now)).toThrow("unavailable");
    expect(()=>moveBlock(base([block("b","a","2026-11-03T15:00:00.000Z","2026-11-03T16:00:00.000Z",{provider:"google",accountId:"a",calendarId:"c",eventId:"e",version:"1"})]),s,"b","2026-11-03T16:00:00.000Z",now)).toThrow("Reconnect");
    expect(()=>moveBlock(base([]),s,"missing","2026-11-03T16:00:00.000Z",now)).toThrow("no longer available");
  });
  it("keeps breakdown steps in order",()=>{
    const s=state([task("parent"),task("one"),task("two")]);
    const linked=linkChildren(DEFAULT_PLANNING,ref("parent"),[{ref:ref("one"),estimateMinutes:60,order:0},{ref:ref("two"),estimateMinutes:60,order:1}]);
    const d={...linked,calendarSource:"ics" as const,blocks:[block("first","one","2026-11-03T16:00:00.000Z","2026-11-03T17:00:00.000Z"),block("second","two","2026-11-03T18:00:00.000Z","2026-11-03T19:00:00.000Z")]};
    expect(()=>moveBlock(d,s,"first","2026-11-03T20:00:00.000Z",now)).toThrow("must finish before two");
    expect(()=>moveBlock(d,s,"second","2026-11-03T15:00:00.000Z",now)).toThrow("one must finish first");
  });
});

describe("rolling calendar planning",()=>{
  it("uses the configured planning timezone regardless of the injected clock's zone",()=>{
    const s=state([task("a")]);const d={...setEstimate(DEFAULT_PLANNING,ref("a"),30),calendarSource:"ics" as const,calendarImportedAt:"2026-11-02T14:00:00Z"};
    const instant=DateTime.fromISO("2026-11-02T14:00:00Z",{setZone:true});
    const utc=generatePlan(d,s,instant),local=generatePlan(d,s,instant.setZone("America/Chicago"));
    expect(utc.items).toEqual(local.items);expect(utc.capacityMinutes).toBe(local.capacityMinutes);
    expect(utc.items[0].start).toBe("2026-11-02T15:00:00.000Z");
    expect(approvePlan(d,s,utc,[JSON.stringify(["notion","db","a"])],instant.plus({seconds:2})).blocks).toHaveLength(1);
  });
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
  it("restores a partial breakdown journal and confirmed child metadata after restart",()=>{
    const parent=ref("parent"),child=ref("created-child");const linked=linkChildren(DEFAULT_PLANNING,parent,[{ref:child,estimateMinutes:20,order:0}]);
    const saved={...linked,operations:[{id:"op",parent,steps:[{name:"Step 1",estimateMinutes:20,order:0,status:"created" as const,ref:child},{name:"Step 2",estimateMinutes:40,order:1,status:"recovery-needed" as const,message:"Result is uncertain"}],status:"recovery-needed" as const,updatedAt:"2026-10-30T00:00:00.000Z"}]};
    const restored=cleanPlanning(JSON.parse(JSON.stringify(saved)));
    expect(restored.tasks.find(x=>x.ref.taskId===child.taskId)).toMatchObject({estimateMinutes:20,parent,stepOrder:0});
    expect(restored.operations[0]).toMatchObject({status:"recovery-needed",steps:[{status:"created",ref:child},{status:"recovery-needed",message:"Result is uncertain"}]});
  });
  it("rejects an approval after input revision changes and is idempotent",()=>{
    const s=state([task("a")]);let d=setEstimate(DEFAULT_PLANNING,ref("a"),30);d={...d,calendarImportedAt:"2026-10-30T00:00:00Z",calendarSource:"ics"};const proposal=generatePlan(d,s,DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago"));
    expect(()=>approvePlan({...d,inputRevision:d.inputRevision+1},s,proposal,[JSON.stringify(["notion","db","a"])] )).toThrow(/stale/i);
    const asOf=DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago");const first=approvePlan(d,s,proposal,[JSON.stringify(["notion","db","a"])],asOf);const second=approvePlan(first,s,proposal,[JSON.stringify(["notion","db","a"])],asOf);expect(second.blocks).toHaveLength(1);
  });
  it("leaves review time before today's first proposal and accepts a delayed approval within the review window",()=>{
    const s=state([task("a")]);const d={...setEstimate(DEFAULT_PLANNING,ref("a"),30),calendarImportedAt:"snapshot",calendarSource:"ics" as const};const generated=DateTime.fromISO("2026-11-02T15:00:00Z").setZone("America/Chicago");const p=generatePlan(d,s,generated);
    expect(DateTime.fromISO(p.items[0].start).diff(generated,"minutes").minutes).toBe(5);
    const approved=approvePlan(d,s,p,[JSON.stringify(["notion","db","a"])],generated.plus({minutes:2}));expect(approved.blocks).toHaveLength(1);
    expect(()=>approvePlan(d,s,p,[JSON.stringify(["notion","db","a"])],generated.plus({minutes:31}))).toThrow(/expired/i);
  });
  it("does not treat manual commitments as a complete calendar without explicit empty-calendar choice",()=>{
    const s=state([task("a")]);const d={...setEstimate(DEFAULT_PLANNING,ref("a"),30),calendarImportedAt:"manual",calendarSource:"manual" as const,events:[{id:"manual",title:"Appointment",start:"2026-11-02T15:00:00Z",end:"2026-11-02T16:00:00Z"}]};
    expect(()=>generatePlan(d,s,DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago"))).toThrow(/complete/i);
    expect(generatePlan({...d,settings:{...d.settings,allowEmptyCalendar:true}},s,DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago")).items).toHaveLength(1);
  });
  it("sets an ICS snapshot aside while live and restores it only through the explicit switch",()=>{
    const sync={...DEFAULT_PLANNING.calendarSync!,selectedKeys:["key"],defaultDestinationKey:"key"};
    const ics={id:"uid",title:"Dentist",start:"2026-11-02T15:00:00Z",end:"2026-11-02T16:00:00Z"},manual={id:"manual-1",title:"Lunch",start:"2026-11-03T15:00:00Z",end:"2026-11-03T16:00:00Z"};
    const local={...DEFAULT_PLANNING,events:[ics,manual],calendarSource:"ics" as const,calendarImportedAt:"2026-11-01T00:00:00Z",calendarSync:sync};
    const stashed=stashLocalCalendar(local);expect(stashed.localCalendar).toEqual({events:[ics],importedAt:"2026-11-01T00:00:00Z",source:"ics"});
    const live={...stashed,events:[manual,{id:"google:a",title:"Live",start:"2026-11-04T15:00:00Z",end:"2026-11-04T16:00:00Z"}],calendarSource:null,calendarSync:{...sync,mode:"live" as const}};
    expect(cleanPlanning(JSON.parse(JSON.stringify(live))).localCalendar?.events).toEqual([ics]);
    const restored=restoreLocalCalendar({...live,settings:{...live.settings,allowEmptyCalendar:true}});
    expect(restored.events.map(x=>x.id)).toEqual(["uid","manual-1"]);expect(restored).toMatchObject({calendarSource:"ics",calendarImportedAt:"2026-11-01T00:00:00Z",settings:{allowEmptyCalendar:false},calendarSync:{mode:"local",selectedKeys:[],defaultDestinationKey:null}});
  });
  it("keeps current local events when the explicit switch runs outside live mode",()=>{
    const ics={id:"uid",title:"Dentist",start:"2026-11-02T15:00:00Z",end:"2026-11-02T16:00:00Z"};
    expect(restoreLocalCalendar({...DEFAULT_PLANNING,events:[ics],calendarSource:"ics",calendarImportedAt:"2026-11-01T00:00:00Z"})).toMatchObject({events:[ics],calendarSource:"ics"});
  });
  it("keeps planning paused instead of using local data after a live refresh failure",()=>{
    const s=state([task("a")]);const d={...setEstimate(DEFAULT_PLANNING,ref("a"),30),calendarSource:"ics" as const,localCalendar:{events:[],importedAt:"snapshot",source:"ics" as const},calendarSync:{...DEFAULT_PLANNING.calendarSync!,mode:"live" as const,lastSyncedAt:"2026-11-02T13:00:00Z",error:"Google sign-in expired."}};
    expect(()=>generatePlan(d,s,DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago"))).toThrow("Google sign-in expired.");
  });
  describe("user placements",()=>{
    const now=DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago");
    const key=(id:string)=>JSON.stringify(["notion","db",id]);
    const ready=(minutes=30)=>({...setEstimate(DEFAULT_PLANNING,ref("a"),minutes),calendarImportedAt:"snapshot",calendarSource:"ics" as const});
    const check=(d:PlanningData,s:AppState,p:ReturnType<typeof generatePlan>,start:string,k=key("a"),selected=[k])=>placementConflict(k,{data:d,tasks:s.tasks,proposal:applyPlacements(p,[{key:k,start}]),selected,now});
    it("approves the user's time and keeps the task link and duration",()=>{
      const s=state([task("a")]);const d=ready(45);const p=generatePlan(d,s,now);const start="2026-11-03T18:00:00.000Z";
      const approved=approvePlan(d,s,p,[key("a")],now,[{key:key("a"),start}]);
      expect(approved.blocks).toHaveLength(1);expect(approved.blocks[0]).toMatchObject({ref:ref("a"),start,end:"2026-11-03T18:45:00.000Z"});
      expect(approvePlan(approved,s,p,[key("a")],now,[{key:key("a"),start}])).toEqual(approved);
    });
    it("rejects placements for unknown keys, repeats, and invalid times",()=>{
      const s=state([task("a")]);const d=ready();const p=generatePlan(d,s,now);
      expect(()=>applyPlacements(p,[{key:key("other"),start:"2026-11-03T18:00:00Z"}])).toThrow(/invalid/);
      expect(()=>applyPlacements(p,[{key:key("a"),start:"soon"}])).toThrow(/invalid/);
      expect(()=>applyPlacements(p,[{key:key("a"),start:"2026-11-03T18:00:00Z"},{key:key("a"),start:"2026-11-03T19:00:00Z"}])).toThrow(/more than once/);
    });
    it("keeps availability, the horizon, and past times out of reach",()=>{
      const s=state([task("a")]);const d=ready();const p=generatePlan(d,s,now);
      expect(check(d,s,p,"2026-11-03T18:00:00.000Z")).toBeNull();
      expect(check(d,s,p,"2026-11-03T12:00:00.000Z")).toMatch(/working hours/);
      expect(check(d,s,p,"2026-11-03T22:45:00.000Z")).toMatch(/working hours/);
      expect(check(d,s,p,"2026-11-07T18:00:00.000Z")).toMatch(/Saturday is not a working day/);
      expect(check(d,s,p,"2026-11-09T18:00:00.000Z")).toMatch(/seven planning dates/);
      expect(check(d,s,p,"2026-11-02T13:30:00.000Z")).toMatch(/passed/);
    });
    it("uses the planning timezone for working hours",()=>{
      const s=state([task("a")]);const d={...ready(),settings:{...DEFAULT_PLANNING.settings,timezone:"Asia/Tokyo"}};const p=generatePlan(d,s,now);
      expect(check(d,s,p,"2026-11-03T01:00:00.000Z")).toBeNull();
      expect(check(d,s,p,"2026-11-03T18:00:00.000Z")).toMatch(/working/);
    });
    it("allows a block to end exactly at the end of a 24-hour working day",()=>{
      const s=state([task("a")]);const d={...ready(),settings:{...DEFAULT_PLANNING.settings,timezone:"America/Chicago",startHour:0,endHour:24}};const p=generatePlan(d,s,now);
      expect(check(d,s,p,"2026-11-04T05:30:00.000Z")).toBeNull();
      expect(check(d,s,p,"2026-11-04T05:45:00.000Z")).toMatch(/working hours/);
    });
    it("names fixed events, approved blocks, and other proposals it would overlap",()=>{
      const s=state([task("a"),task("b"),task("c")]);let d:PlanningData=ready();d=setEstimate(d,ref("b"),30);d={...d,events:[{id:"meeting",title:"Team meeting",start:"2026-11-03T18:00:00Z",end:"2026-11-03T19:00:00Z"}],blocks:[{id:"kept",ref:ref("c"),start:"2026-11-04T18:00:00Z",end:"2026-11-04T19:00:00Z",approvedAt:"2026-10-30T00:00:00Z"}]};const p=generatePlan(d,s,now);
      expect(check(d,s,p,"2026-11-03T18:30:00.000Z")).toMatch(/Team meeting/);
      expect(check(d,s,p,"2026-11-03T19:00:00.000Z")).toBeNull();
      expect(check(d,s,p,"2026-11-04T18:30:00.000Z")).toMatch(/approved block for c/);
      const b=p.items.find(x=>x.ref.taskId==="b")!;
      expect(check(d,s,p,b.start,key("a"),[key("a"),key("b")])).toMatch(/proposed block for b/);
      expect(check(d,s,p,b.start,key("a"),[key("a")])).toBeNull();
    });
    it("does not treat the calendar copy of an owned block as a fixed event",()=>{
      const s=state([task("a"),task("owned")]);const d={...ready(),blocks:[{id:"owned-block",ref:ref("owned"),start:"2026-11-02T16:00:00Z",end:"2026-11-02T16:30:00Z",approvedAt:"2026-10-30T00:00:00Z"}],events:[{id:"owned-block@notion-tasks.local",title:"owned",start:"2026-11-02T16:00:00Z",end:"2026-11-02T16:30:00Z"},{id:"real",title:"Real",start:"2026-11-02T17:00:00Z",end:"2026-11-02T17:30:00Z"}]};
      expect(fixedEvents(d).map(x=>x.id)).toEqual(["real"]);
    });
    it("keeps breakdown steps in order",()=>{
      const s=state([task("parent"),task("first"),task("second")]);let d=linkChildren(setEstimate(DEFAULT_PLANNING,ref("parent"),null),ref("parent"),[{ref:ref("first"),estimateMinutes:30,order:0},{ref:ref("second"),estimateMinutes:30,order:1}]);d={...d,calendarImportedAt:"snapshot",calendarSource:"ics"};const p=generatePlan(d,s,now);const selected=[key("first"),key("second")];
      expect(check(d,s,p,"2026-11-03T18:00:00.000Z",key("first"),selected)).toMatch(/must finish before second/);
      const reversed=applyPlacements(p,[{key:key("first"),start:"2026-11-03T18:00:00.000Z"},{key:key("second"),start:"2026-11-03T16:00:00.000Z"}]);
      expect(placementConflict(key("second"),{data:d,tasks:s.tasks,proposal:reversed,selected,now})).toMatch(/first must finish first/);
      expect(()=>approvePlan(d,s,p,selected,now,[{key:key("first"),start:"2026-11-03T18:00:00.000Z"}])).toThrow(/no longer fits/);
    });
    it("refuses a placement that passes its deadline",()=>{
      const s=state([task("a",false,{start:"2026-11-03",end:null})]);const d=ready();const p=generatePlan(d,s,now);
      expect(check(d,s,p,"2026-11-03T18:00:00.000Z")).toBeNull();expect(check(d,s,p,"2026-11-04T18:00:00.000Z")).toMatch(/deadline/);
    });
    it("moves a proposed block replacement and leaves unselected placements unchecked",()=>{
      const s=state([task("a"),task("b")]);let d:PlanningData=ready();d={...d,events:[{id:"meeting",title:"Meeting",start:"2026-11-02T15:00:00Z",end:"2026-11-02T16:00:00Z"}],blocks:[{id:"owned",ref:ref("a"),start:"2026-11-02T15:30:00Z",end:"2026-11-02T16:00:00Z",approvedAt:"2026-10-30T00:00:00Z"}]};const p=generatePlan(d,s,now);const start="2026-11-03T20:00:00.000Z";
      expect(approvePlan(d,s,p,["move:owned"],now,[{key:"move:owned",start}]).blocks[0]).toMatchObject({id:"owned",start,end:"2026-11-03T20:30:00.000Z"});
    });
    it("still rejects stale inputs instead of applying a placement",()=>{
      const s=state([task("a")]);const d=ready();const p=generatePlan(d,s,now);
      expect(()=>approvePlan({...d,inputRevision:d.inputRevision+1},s,p,[key("a")],now,[{key:key("a"),start:"2026-11-03T18:00:00.000Z"}])).toThrow(/stale/i);
    });
  });
  it("rejects recurrence without replacing the prior snapshot",()=>{
    const ics="BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261102T150000Z\r\nDTEND:20261102T160000Z\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(()=>parseCalendarICS(ics,"America/Chicago")).toThrow(/recurring/i);
  });
  it("rejects recurrence properties with parameters regardless of property-name case",()=>{
    for(const recurrence of [
      "RDATE;TZID=America/Chicago:20261103T090000",
      "EXDATE;VALUE=DATE:20261103",
      "rdate;TZID=America/Chicago:20261103T090000",
      "exdate;value=date:20261103",
      "Recurrence-Id;VALUE=DATE:20261103",
      "RRULE;X-TEST=1:FREQ=WEEKLY",
    ]) {
      const ics=`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261102T150000Z\r\nDTEND:20261102T160000Z\r\n${recurrence}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
      expect(()=>parseCalendarICS(ics,"America/Chicago"),recurrence).toThrow(/recurring/i);
    }
  });
  it("unfolds recurrence properties before validating them",()=>{
    const ics="BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261102T150000Z\r\nDTEND:20261102T160000Z\r\nrRule:FREQ=WEEKLY;\r\n BYDAY=MO\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(()=>parseCalendarICS(ics,"America/Chicago")).toThrow(/recurring/i);
  });
  it("imports ordinary parameterized events and does not confuse description text for a property",()=>{
    const ics="BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:ordinary\r\nDTSTART;TZID=America/Chicago:20261103T090000\r\nDTEND;TZID=America/Chicago:20261103T100000\r\nSUMMARY;LANGUAGE=en:Planning\r\nDESCRIPTION:Please check the RRULE: text in the calendar guide.\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(parseCalendarICS(ics,"America/Chicago").events).toEqual([{id:"ordinary",title:"Planning",start:"2026-11-03T15:00:00.000Z",end:"2026-11-03T16:00:00.000Z",allDay:false}]);
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
  it("rejects a selected addition that overlaps an unchecked move's retained original block",()=>{
    const s=state([task("a"),task("b")]);let d=setEstimate(DEFAULT_PLANNING,ref("a"),60);d=setEstimate(d,ref("b"),30);d={...d,calendarImportedAt:"snapshot",calendarSource:"ics",events:[{id:"meeting",title:"Meeting",start:"2026-11-02T15:30:00Z",end:"2026-11-02T16:30:00Z"}],blocks:[{id:"owned-a",ref:ref("a"),start:"2026-11-02T15:00:00Z",end:"2026-11-02T16:00:00Z",approvedAt:"2026-10-30T00:00:00Z"}]};
    const now=DateTime.fromISO("2026-11-02T14:55:00Z").setZone("America/Chicago");const p=generatePlan(d,s,now);expect(p.moves).toHaveLength(1);expect(p.items.find(x=>x.ref.taskId==="b")?.start).toBe("2026-11-02T15:00:00.000Z");
    expect(()=>approvePlan(d,s,p,[JSON.stringify(["notion","db","b"])],now)).toThrow(/overlap/i);
    const approved=approvePlan(d,s,p,[`move:owned-a`,JSON.stringify(["notion","db","b"])],now);expect(approved.blocks).toHaveLength(2);
  });
  it("keeps an unchecked removal and its block when approving another task",()=>{
    const s=state([task("done",true),task("new")]);let d=setEstimate(DEFAULT_PLANNING,ref("new"),30);d={...d,calendarImportedAt:"snapshot",calendarSource:"ics",blocks:[{id:"done-block",ref:ref("done"),start:"2026-11-02T16:00:00Z",end:"2026-11-02T16:30:00Z",approvedAt:"2026-10-30T00:00:00Z"}]};const now=DateTime.fromISO("2026-11-02T13:55:00Z").setZone("America/Chicago");const p=generatePlan(d,s,now);
    const approved=approvePlan(d,s,p,[JSON.stringify(["notion","db","new"])],now);expect(approved.blocks.some(b=>b.id==="done-block")).toBe(true);expect(approved.blocks.some(b=>b.ref.taskId==="new")).toBe(true);
  });
  it("rejects successor-only approval unless earlier effort is already covered",()=>{
    const s=state([task("parent"),task("first"),task("second")]);let d=setEstimate(DEFAULT_PLANNING,ref("parent"),null);d=linkChildren(d,ref("parent"),[{ref:ref("first"),estimateMinutes:20,order:0},{ref:ref("second"),estimateMinutes:30,order:1}]);d={...d,calendarImportedAt:"snapshot",calendarSource:"ics"};const now=DateTime.fromISO("2026-11-02T13:55:00Z").setZone("America/Chicago");const p=generatePlan(d,s,now);
    expect(()=>approvePlan(d,s,p,[JSON.stringify(["notion","db","second"])],now)).toThrow(/prerequisite/i);
    expect(approvePlan(d,s,p,p.items.map(x=>JSON.stringify(["notion","db",x.ref.taskId])),now).blocks).toHaveLength(2);
    const priorCompleted=state([task("parent"),task("first",true),task("second")]);const completedProposal=generatePlan(d,priorCompleted,now);expect(approvePlan(d,priorCompleted,completedProposal,[JSON.stringify(["notion","db","second"])],now).blocks).toHaveLength(1);
  });
  it("checks retained successors when a selected move delays their prerequisite",()=>{
    const s=state([task("parent"),task("first"),task("second")]);let d=linkChildren(setEstimate(DEFAULT_PLANNING,ref("parent"),null),ref("parent"),[{ref:ref("first"),estimateMinutes:60,order:0},{ref:ref("second"),estimateMinutes:30,order:1}]);d={...d,calendarImportedAt:"snapshot",calendarSource:"ics",events:[{id:"meeting",title:"Meeting",start:"2026-11-02T15:00:00Z",end:"2026-11-02T15:30:00Z"}],blocks:[{id:"first-block",ref:ref("first"),start:"2026-11-02T15:00:00Z",end:"2026-11-02T16:00:00Z",approvedAt:"2026-10-30T00:00:00Z"},{id:"second-block",ref:ref("second"),start:"2026-11-02T15:30:00Z",end:"2026-11-02T16:00:00Z",approvedAt:"2026-10-30T00:00:00Z"}]};const now=DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago");const p=generatePlan(d,s,now);
    expect(p.moves.find(x=>x.blockId==="first-block")?.start).toBe("2026-11-02T16:00:00.000Z");expect(()=>approvePlan(d,s,p,["move:first-block"],now)).toThrow(/breakdown step/i);
  });
  it("checks a selected successor move against the retained predecessor",()=>{
    const s=state([task("parent"),task("first"),task("second")]);let d=linkChildren(setEstimate(DEFAULT_PLANNING,ref("parent"),null),ref("parent"),[{ref:ref("first"),estimateMinutes:20,order:0},{ref:ref("second"),estimateMinutes:20,order:1}]);d={...d,calendarImportedAt:"snapshot",calendarSource:"ics",events:[{id:"meeting",title:"Meeting",start:"2026-11-02T16:30:00Z",end:"2026-11-02T17:00:00Z"}],blocks:[{id:"first-block",ref:ref("first"),start:"2026-11-02T16:00:00Z",end:"2026-11-02T16:20:00Z",approvedAt:"2026-10-30T00:00:00Z"},{id:"second-block",ref:ref("second"),start:"2026-11-02T16:30:00Z",end:"2026-11-02T16:50:00Z",approvedAt:"2026-10-30T00:00:00Z"}]};const now=DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago");const p=generatePlan(d,s,now);
    expect(p.moves.find(x=>x.blockId==="second-block")?.start).toBe("2026-11-02T15:00:00.000Z");expect(()=>approvePlan(d,s,p,["move:second-block"],now)).toThrow(/breakdown step/i);
  });
  it("does not use a historical block as prerequisite effort",()=>{
    const s=state([task("parent"),task("first"),task("second")]);let d=linkChildren(setEstimate(DEFAULT_PLANNING,ref("parent"),null),ref("parent"),[{ref:ref("first"),estimateMinutes:20,order:0},{ref:ref("second"),estimateMinutes:20,order:1}]);d={...d,calendarImportedAt:"snapshot",calendarSource:"ics",blocks:[{id:"historical-first",ref:ref("first"),start:"2026-11-02T13:00:00Z",end:"2026-11-02T13:20:00Z",approvedAt:"2026-10-30T00:00:00Z"}]};const now=DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago");const p=generatePlan(d,s,now);
    expect(p.items.map(x=>x.ref.taskId)).toEqual(["first","second"]);expect(()=>approvePlan(d,s,p,[JSON.stringify(["notion","db","second"])],now)).toThrow(/breakdown step/i);
  });
  it("rejects removal of incomplete prerequisite blocks while preserving completed-task semantics",()=>{
    const s=state([task("parent"),task("second")]);let d=linkChildren(setEstimate(DEFAULT_PLANNING,ref("parent"),null),ref("parent"),[{ref:ref("missing-first"),estimateMinutes:20,order:0},{ref:ref("second"),estimateMinutes:20,order:1}]);d={...d,calendarImportedAt:"snapshot",calendarSource:"ics",blocks:[{id:"missing-first-block",ref:ref("missing-first"),start:"2026-11-02T15:00:00Z",end:"2026-11-02T15:20:00Z",approvedAt:"2026-10-30T00:00:00Z"},{id:"second-block",ref:ref("second"),start:"2026-11-02T16:00:00Z",end:"2026-11-02T16:20:00Z",approvedAt:"2026-10-30T00:00:00Z"}]};const now=DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago");const p=generatePlan(d,s,now);
    expect(p.removals.some(x=>x.blockId==="missing-first-block")).toBe(true);expect(()=>approvePlan(d,s,p,["remove:missing-first-block"],now)).toThrow(/breakdown step/i);
  });
  it("allows an unrelated approval when an existing conflict is unchanged",()=>{
    const s=state([task("conflicted"),task("new")]);let d=setEstimate(DEFAULT_PLANNING,ref("conflicted"),60);d=setEstimate(d,ref("new"),30);d={...d,calendarImportedAt:"snapshot",calendarSource:"ics",events:[{id:"meeting",title:"Meeting",start:"2026-11-02T15:00:00Z",end:"2026-11-02T16:00:00Z"}],blocks:[{id:"existing-conflict",ref:ref("conflicted"),start:"2026-11-02T15:00:00Z",end:"2026-11-02T16:00:00Z",approvedAt:"2026-10-30T00:00:00Z"}]};const now=DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago");const p=generatePlan(d,s,now);const newItem=p.items.find(x=>x.ref.taskId==="new");expect(newItem).toBeDefined();expect(approvePlan(d,s,p,[JSON.stringify(["notion","db","new"])],now).blocks.some(b=>b.ref.taskId==="new")).toBe(true);
  });
  it("allows approving another task when an imported event is the exact exported copy of an owned block",()=>{
    const s=state([task("owned"),task("new")]);let d=setEstimate(DEFAULT_PLANNING,ref("owned"),30);d=setEstimate(d,ref("new"),30);d={...d,calendarImportedAt:"snapshot",calendarSource:"ics",blocks:[{id:"owned-block",ref:ref("owned"),start:"2026-11-02T16:00:00Z",end:"2026-11-02T16:30:00Z",approvedAt:"2026-10-30T00:00:00Z"}],events:[{id:"owned-block@notion-tasks.local",title:"owned",start:"2026-11-02T16:00:00Z",end:"2026-11-02T16:30:00Z"}]};const now=DateTime.fromISO("2026-11-02T14:00:00Z").setZone("America/Chicago");const p=generatePlan(d,s,now);expect(approvePlan(d,s,p,[JSON.stringify(["notion","db","new"])],now).blocks.some(b=>b.ref.taskId==="new")).toBe(true);
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
