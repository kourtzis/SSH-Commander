import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/auth-context";
import {
  LayoutDashboard,
  Server,
  Network,
  Code2,
  PlaySquare,
  Users,
  LogOut,
  TerminalSquare,
  Clock,
  Menu,
  X
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Routers", href: "/routers", icon: Server },
  { name: "Groups", href: "/groups", icon: Network },
  { name: "Snippets", href: "/snippets", icon: Code2 },
  { name: "Batch Jobs", href: "/jobs", icon: PlaySquare },
  { name: "Scheduler", href: "/scheduler", icon: Clock },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  useEffect(() => {
    if (!mobileOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [mobileOpen]);

  const items = [...navItems];
  if (user?.role === "admin") {
    items.push({ name: "Users", href: "/users", icon: Users });
  }

  const sidebarContent = (
    <>
      <div className="p-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-primary/20 p-2 rounded-xl text-primary border border-primary/30 shadow-[0_0_15px_rgba(45,212,191,0.2)]">
            <TerminalSquare className="w-6 h-6" />
          </div>
          <span className="font-display font-bold text-xl tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-white/70">
            SSH Commander
          </span>
        </div>
        <button
          onClick={() => setMobileOpen(false)}
          className="md:hidden p-1.5 rounded-lg hover:bg-white/10 text-muted-foreground"
          aria-label="Close menu"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
        {items.map((item) => {
          const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link key={item.name} href={item.href} className="block">
              <div className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all duration-200 cursor-pointer group",
                isActive 
                  ? "bg-primary/10 text-primary font-medium border border-primary/20 shadow-inner" 
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
              )}>
                <item.icon className={cn(
                  "w-5 h-5 transition-transform duration-200", 
                  isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground group-hover:scale-110"
                )} />
                {item.name}
              </div>
            </Link>
          );
        })}
      </div>

      <div className="p-4 border-t border-sidebar-border bg-black/20">
        <div className="flex items-center gap-3 mb-4 px-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-primary to-accent flex items-center justify-center text-sm font-bold text-white shadow-lg">
            {user?.username?.charAt(0).toUpperCase() || 'U'}
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium leading-none">{user?.username}</span>
            <span className="text-xs text-muted-foreground mt-1 capitalize">{user?.role}</span>
          </div>
        </div>
        <button 
          onClick={() => logout()}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-destructive/80 hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      </div>
    </>
  );

  return (
    <>
      {!mobileOpen && (
        <button
          onClick={() => setMobileOpen(true)}
          className="md:hidden fixed top-4 left-4 z-50 p-2 rounded-xl bg-sidebar border border-sidebar-border text-sidebar-foreground shadow-lg"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>
      )}

      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/60 z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <div className={cn(
        "w-64 h-screen bg-sidebar border-r border-sidebar-border flex flex-col fixed left-0 top-0 text-sidebar-foreground z-50 transition-transform duration-300",
        "md:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        {sidebarContent}
      </div>
    </>
  );
}
