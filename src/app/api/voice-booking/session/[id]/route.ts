import { NextRequest } from "next/server";
import { GET as getSession } from "../route";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const url = new URL(req.url);
  url.searchParams.set("sessionId", id);
  const forwardedReq = new NextRequest(url.toString(), {
    headers: req.headers,
    method: req.method,
  });
  return getSession(forwardedReq);
}
