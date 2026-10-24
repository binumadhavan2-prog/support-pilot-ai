import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth/auth";

// Resolve the auth instance per request so builds do not need runtime secrets.
export const { GET, POST } = toNextJsHandler((request) => getAuth().handler(request));
