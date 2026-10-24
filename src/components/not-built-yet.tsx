import { Construction } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Placeholder for a section that is not implemented yet. Deliberately shows no sample data, so
 * nothing on screen can be mistaken for a working feature.
 */
export function NotBuiltYet({ phase, summary }: { phase: string; summary: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Construction className="size-4 text-muted-foreground" aria-hidden />
          <CardTitle>Not built yet</CardTitle>
          <Badge variant="outline">{phase}</Badge>
        </div>
        <CardDescription>{summary}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        This page has no data yet. The section is in the navigation so the layout and access rules
        can be tested now.
      </CardContent>
    </Card>
  );
}
