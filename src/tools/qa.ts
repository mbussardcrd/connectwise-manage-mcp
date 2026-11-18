// src/tools/qa.ts
// Read-only QA tools for ticket review. Follows the same pattern as src/tools/*.ts:
//   export function registerXTools(server: McpServer, client: CwManageClient)
//   server.tool(name, description, zodShape, handler)
//   client.get<T>(path)
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CwManageClient } from "../api-client.js";

type Rec = Record<string, unknown>;
type Ref = { id?: number; name?: string; identifier?: string } | undefined;

const PAGE_SIZE = 250;
const MAX_PAGES = 20; // safety cap: 5,000 records per query

const PT = "America/Los_Angeles";
const today = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: PT }).format(new Date());
const nextDay = (d: string): string =>
  new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** Pacific midnight as a CW UTC literal: 07:00Z during PDT, 08:00Z during PST. */
const ptMidnight = (d: string): string => {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: PT, hour: "2-digit", hourCycle: "h23" })
    .format(new Date(`${d}T07:00:00Z`));
  return h === "00" ? `[${d}T07:00:00Z]` : `[${d}T08:00:00Z]`;
};
const dayStart = (d: string): string => ptMidnight(d);
const dayEnd = (d: string): string => ptMidnight(nextDay(d)); // exclusive end (use <)
const clip = (s: unknown, n: number): string => {
  const t = typeof s === "string" ? s : "";
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const ref = (v: unknown): Ref => (v && typeof v === "object" ? (v as Ref) : undefined);

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: `QA tool error: ${e instanceof Error ? e.message : String(e)}` }],
});

/** GET every page of a CW list endpoint using the shared client (auth handled by the client). */
async function getAll(client: CwManageClient, path: string, params: Record<string, string>): Promise<Rec[]> {
  const out: Rec[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({ ...params, page: String(page), pageSize: String(PAGE_SIZE) });
    const batch = await client.get<Rec[]>(`${path}?${qs.toString()}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

/** Run async work over items with limited concurrency to stay under CW API rate limits. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]);
      }
    }),
  );
  return results;
}

const TICKET_FIELDS =
  "id,summary,board/name,status/name,type/name,subType/name,item/name,budgetHours,actualHours,company/name,owner/identifier,resources,lastUpdated";

function getTicketTime(client: CwManageClient, ticketId: number, fields: string): Promise<Rec[]> {
  return getAll(client, "/time/entries", {
    conditions: `chargeToType="ServiceTicket" AND chargeToId=${ticketId}`,
    fields,
    orderBy: "timeStart asc",
  });
}

async function completedTickets(client: CwManageClient, date: string, board?: string): Promise<Rec[]> {
  let conditions = `status/name in ("Completed~","Completed - Silent") and lastUpdated>=${dayStart(date)} and lastUpdated<${dayEnd(date)}`;
  if (board) conditions += ` and board/name="${board.replace(/"/g, '\\"')}"`;
  return getAll(client, "/service/tickets", { conditions, fields: TICKET_FIELDS, orderBy: "lastUpdated desc" });
}

const dateArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-mm-dd")
  .optional()
  .describe("Date in yyyy-mm-dd (Pacific). Defaults to today.");

export function registerQaTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_qa_completed_tickets",
    "QA (read-only): List service tickets completed (Completed~ or Completed - Silent) on a date (default today), optionally filtered by exact board name. Returns id, summary, board, status, type/subtype/item (TSI), budget and actual hours, company, owner.",
    {
      date: dateArg,
      board: z.string().optional().describe("Exact ConnectWise service board name"),
    },
    async ({ date, board }) => {
      try {
        const tickets = await completedTickets(client, date ?? today(), board);
        return ok({ date: date ?? today(), count: tickets.length, tickets });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "cw_qa_ticket_context",
    "QA (read-only): Get everything needed to review one ticket: initial description, resolution notes, TSI, board, hours, and all time entries with work type, work role, and notes. Use for resolution checks, TSI validation, board assignment checks, and work type discrepancy checks.",
    {
      ticketId: z.number().int().positive().describe("Service ticket ID"),
    },
    async ({ ticketId }) => {
      try {
        const [ticket, notes, time] = await Promise.all([
          client.get<Rec>(`/service/tickets/${ticketId}?fields=${encodeURIComponent(TICKET_FIELDS)}`),
          getAll(client, `/service/tickets/${ticketId}/notes`, {
            fields: "text,detailDescriptionFlag,internalAnalysisFlag,resolutionFlag,dateCreated,member/identifier",
            orderBy: "dateCreated asc",
          }),
          getTicketTime(client, ticketId, "id,member/identifier,actualHours,workType/name,workRole/name,notes,timeStart"),
        ]);
        const initial = notes.find((n) => n.detailDescriptionFlag === true) ?? notes[0];
        return ok({
          ticket,
          initialDescription: clip(initial?.text, 1500),
          resolutionNotes: notes.filter((n) => n.resolutionFlag === true).map((n) => clip(n.text, 800)),
          internalNotes: notes.filter((n) => n.internalAnalysisFlag === true).map((n) => clip(n.text, 500)),
          timeEntries: time.map((t) => ({
            id: t.id,
            member: ref(t.member)?.identifier,
            hours: num(t.actualHours),
            workType: ref(t.workType)?.name,
            workRole: ref(t.workRole)?.name,
            timeStart: t.timeStart,
            notes: clip(t.notes, 600),
          })),
          totalHours: time.reduce((a, t) => a + num(t.actualHours), 0),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "cw_qa_scheduled_no_time",
    "QA (read-only): Find service tickets where a member had a schedule entry on the date (default today) that has already ended, but that member logged zero hours on the ticket. Rule-based 'scheduled but no time' check.",
    {
      date: dateArg,
    },
    async ({ date }) => {
      try {
        const d = date ?? today();
        const sched = await getAll(client, "/schedule/entries", {
          conditions: `type/identifier="S" AND dateStart>=${dayStart(d)} AND dateStart<${dayEnd(d)}`,
          fields: "id,objectId,member/identifier,dateStart,dateEnd,doneFlag,name",
        });
        const byTicket = new Map<number, Rec[]>();
        for (const s of sched) {
          const tid = num(s.objectId);
          if (tid) byTicket.set(tid, [...(byTicket.get(tid) ?? []), s]);
        }
        const now = Date.now();
        const flagged = await mapLimit([...byTicket.keys()], 5, async (tid) => {
          const time = await getTicketTime(client, tid, "member/identifier,actualHours");
          const hours = new Map<string, number>();
          for (const t of time) {
            const m = ref(t.member)?.identifier ?? "";
            hours.set(m, (hours.get(m) ?? 0) + num(t.actualHours));
          }
          return (byTicket.get(tid) ?? [])
            .filter((s) => {
              const end = Date.parse(String(s.dateEnd ?? ""));
              const m = ref(s.member)?.identifier ?? "";
              return !Number.isNaN(end) && end < now && !((hours.get(m) ?? 0) > 0);
            })
            .map((s) => ({
              ticketId: tid,
              member: ref(s.member)?.identifier,
              scheduledStart: s.dateStart,
              scheduledEnd: s.dateEnd,
              scheduleName: s.name,
              doneFlag: s.doneFlag,
            }));
        });
        const results = flagged.flat();
        return ok({ date: d, count: results.length, results });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "cw_qa_time_outliers",
    "QA (read-only): Flag tickets completed (Completed~ or Completed - Silent) on a date (default today) whose total hours exceed budgetFactor x budget hours, or that have single time entries over maxEntryHours. Returns reasons plus the flagged entries' notes so you can judge whether the time is justified.",
    {
      date: dateArg,
      maxEntryHours: z.number().positive().optional().describe("Flag single entries above this many hours. Default 4."),
      budgetFactor: z.number().positive().optional().describe("Flag tickets above budgetHours x this factor. Default 1.5."),
    },
    async ({ date, maxEntryHours, budgetFactor }) => {
      try {
        const d = date ?? today();
        const maxH = maxEntryHours ?? 4;
        const factor = budgetFactor ?? 1.5;
        const tickets = await completedTickets(client, d);
        const checked = await mapLimit(tickets, 5, async (t) => {
          const time = await getTicketTime(client, num(t.id), "id,member/identifier,actualHours,workType/name,notes");
          const total = time.reduce((a, e) => a + num(e.actualHours), 0);
          const budget = num(t.budgetHours);
          const big = time.filter((e) => num(e.actualHours) > maxH);
          const reasons: string[] = [];
          if (budget > 0 && total > budget * factor) reasons.push(`Total ${total}h exceeds ${factor}x budget (${budget}h)`);
          if (big.length) reasons.push(`${big.length} time entr${big.length > 1 ? "ies" : "y"} over ${maxH}h`);
          if (!reasons.length) return null;
          return {
            ticketId: t.id,
            summary: t.summary,
            board: ref(t.board)?.name,
            type: ref(t.type)?.name,
            subType: ref(t.subType)?.name,
            item: ref(t.item)?.name,
            totalHours: total,
            budgetHours: budget,
            reasons,
            flaggedEntries: big.map((e) => ({
              id: e.id,
              member: ref(e.member)?.identifier,
              hours: num(e.actualHours),
              workType: ref(e.workType)?.name,
              notes: clip(e.notes, 400),
            })),
          };
        });
        const results = checked.filter((r) => r !== null);
        return ok({ date: d, ticketsChecked: tickets.length, count: results.length, results });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
