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
  TerminalSquare
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Routers", href: "/routers", icon: Server },
  { name: "Groups", href: "/groups", icon: Network },
  { name: "Snippets", href: "/snippets", icon: Code2 },
  { name: "Batch Jobs", href: "/jobs", icon: PlaySquare },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { user, logout } = useAuth();

  const items = [...navItems];
  if (user?.role === "admin") {
    items.push({ name: "Users", href: "/users", icon: Users });
  }

  return (
    <div className="w-64 h-screen bg-sidebar border-r border-sidebar-border flex flex-col fixed left-0 top-0 text-sidebar-foreground z-40">
      <div className="p-6 flex items-center gap-3">
        <div className="bg-primary/20 p-2 rounded-xl text-primary border border-primary/30 shadow-[0_0_15px_rgba(45,212,191,0.2)]">
          <TerminalSquare className="w-6 h-6" />
        </div>
        <span className="font-display font-bold text-xl tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-white/70">
          MikroManager
        </span>
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
    </div>
  );
}
