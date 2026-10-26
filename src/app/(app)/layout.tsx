import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { NavMenu, NavUser } from "@/components/app-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { NAV_ITEMS, navItemsFor } from "@/lib/navigation";
import { requirePageUser } from "@/server/auth/session";

/*
 * Shell for signed-in pages. The frame is static; the parts that read the session stream in
 * behind Suspense. Every page still runs its own permission check: a layout check alone does not
 * protect child routes.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <Link href="/inbox">
                  <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
                    SP
                  </span>
                  <span className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">Support Pilot AI</span>
                    <span className="truncate text-xs text-muted-foreground">
                      Support &amp; Ops Copilot
                    </span>
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <Suspense fallback={<NavSkeleton />}>
                <NavForUser />
              </Suspense>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <Suspense fallback={<SidebarMenuSkeleton showIcon />}>
            <UserForSidebar />
          </Suspense>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <span className="text-sm font-medium">Support Pilot AI</span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>
        <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function NavSkeleton() {
  return (
    <SidebarMenu>
      {NAV_ITEMS.map((item) => (
        <SidebarMenuItem key={item.href}>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

async function NavForUser() {
  const user = await requirePageUser();
  const items = navItemsFor(user.role).map(({ href, label, icon }) => ({ href, label, icon }));
  return <NavMenu items={items} />;
}

async function UserForSidebar() {
  const { name, email, role } = await requirePageUser();
  return <NavUser user={{ name, email, role }} />;
}
