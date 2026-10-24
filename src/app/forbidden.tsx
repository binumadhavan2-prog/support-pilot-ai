import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Forbidden() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <p className="text-sm font-semibold text-muted-foreground">403</p>
      <h1 className="text-2xl font-semibold">Access denied</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Your role does not include access to this page. Ask an administrator if you need it.
      </p>
      <Button asChild variant="outline">
        <Link href="/inbox">Back to inbox</Link>
      </Button>
    </main>
  );
}
