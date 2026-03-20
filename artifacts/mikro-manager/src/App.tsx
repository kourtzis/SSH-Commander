import React from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/auth-context";
import { AppLayout } from "@/components/layout/app-layout";
import { Loader2 } from "lucide-react";
import NotFound from "@/pages/not-found";

// Pages
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import Routers from "@/pages/routers";
import Groups from "@/pages/groups";
import Snippets from "@/pages/snippets";
import JobsList from "@/pages/jobs/index";
import NewJob from "@/pages/jobs/new";
import JobDetail from "@/pages/jobs/detail";
import Users from "@/pages/users";
import SchedulerList from "@/pages/scheduler/index";
import NewSchedule from "@/pages/scheduler/new";

const queryClient = new QueryClient();

// Protected route wrapper
function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  React.useEffect(() => {
    if (!isLoading && !user) {
      setLocation("/login");
    }
  }, [isLoading, user, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <AppLayout>
      <Component />
    </AppLayout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/" component={() => <ProtectedRoute component={Dashboard} />} />
      <Route path="/routers" component={() => <ProtectedRoute component={Routers} />} />
      <Route path="/groups" component={() => <ProtectedRoute component={Groups} />} />
      <Route path="/snippets" component={() => <ProtectedRoute component={Snippets} />} />
      <Route path="/jobs" component={() => <ProtectedRoute component={JobsList} />} />
      <Route path="/jobs/new" component={() => <ProtectedRoute component={NewJob} />} />
      <Route path="/jobs/:id" component={() => <ProtectedRoute component={JobDetail} />} />
      <Route path="/scheduler" component={() => <ProtectedRoute component={SchedulerList} />} />
      <Route path="/scheduler/new" component={() => <ProtectedRoute component={NewSchedule} />} />
      <Route path="/users" component={() => <ProtectedRoute component={Users} />} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
