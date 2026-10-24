import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic redirect only: checks that a session cookie *exists*, so anonymous visitors get a
 * real 307 to /login instead of a streamed redirect. It does not validate the session. Pages,
 * server actions and API routes still authorize every request on the server.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Signed-in areas only. Keep in sync with routes under src/app/(app).
  matcher: [
    "/inbox/:path*",
    "/approvals/:path*",
    "/incidents/:path*",
    "/analytics/:path*",
    "/knowledge/:path*",
    "/settings/:path*",
    "/tickets/:path*",
    "/ask/:path*",
  ],
};
