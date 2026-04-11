import React, { Suspense } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/auth-context";
import { AppLayout } from "@/components/layout/app-layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { ConfirmProvider } from "@/components/confirm-dialog";
import { Loader2 } from "lucide-react";

const Login = React.lazy(() => import("@/pages/login"));
const Dashboard = React.lazy(() => import("@/pages/dashboard"));
const Routers = React.lazy(() => import("@/pages/routers"));
const Groups = React.lazy(() => import("@/pages/groups"));
const Snippets = React.lazy(() => import("@/pages/snippets"));
const JobsList = React.lazy(() => import("@/pages/jobs/index"));
const NewJob = React.lazy(() => import("@/pages/jobs/new"));
const JobDetail = React.lazy(() => import("@/pages/jobs/detail"));
const Users = React.lazy(() => import("@/pages/users"));
const SchedulerList = React.lazy(() => import("@/pages/scheduler/index"));
const NewSchedule = React.lazy(() => import("@/pages/scheduler/new"));
const NotFound = React.lazy(() => import("@/pages/not-found"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

function PageLoader() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <Loader2 className="w-8 h-8 text-primary animate-spin" />
    </div>
  );
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  React.useEffect(() => {
    if (!isLoading && !user) {
      setLocation("/login");
    }
  }, [isLoading, user, setLocation]);

  if (isLoading) {
    return <PageLoader />;
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

const ProtectedDashboard = () => <ProtectedRoute component={Dashboard} />;
const ProtectedRouters = () => <ProtectedRoute component={Routers} />;
const ProtectedGroups = () => <ProtectedRoute component={Groups} />;
const ProtectedSnippets = () => <ProtectedRoute component={Snippets} />;
const ProtectedJobsList = () => <ProtectedRoute component={JobsList} />;
const ProtectedNewJob = () => <ProtectedRoute component={NewJob} />;
const ProtectedJobDetail = () => <ProtectedRoute component={JobDetail} />;
const ProtectedSchedulerList = () => <ProtectedRoute component={SchedulerList} />;
const ProtectedNewSchedule = () => <ProtectedRoute component={NewSchedule} />;
const ProtectedUsers = () => <ProtectedRoute component={Users} />;

function Router() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Switch>
        <Route path="/login" component={Login} />
        <Route path="/" component={ProtectedDashboard} />
        <Route path="/routers" component={ProtectedRouters} />
        <Route path="/groups" component={ProtectedGroups} />
        <Route path="/snippets" component={ProtectedSnippets} />
        <Route path="/jobs" component={ProtectedJobsList} />
        <Route path="/jobs/new" component={ProtectedNewJob} />
        <Route path="/jobs/:id" component={ProtectedJobDetail} />
        <Route path="/scheduler" component={ProtectedSchedulerList} />
        <Route path="/scheduler/new" component={ProtectedNewSchedule} />
        <Route path="/users" component={ProtectedUsers} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthProvider>
            <ConfirmProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                <Router />
              </WouterRouter>
              <Toaster />
            </ConfirmProvider>
          </AuthProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
