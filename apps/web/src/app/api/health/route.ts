import { GET as operationsHealthGET } from "../operations/health/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return operationsHealthGET();
}
