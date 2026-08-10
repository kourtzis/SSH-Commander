import { useState } from "react";
import { 
  useListAuditLog, 
  useListAuditActions, 
  getListAuditLogQueryKey, 
  getListAuditActionsQueryKey 
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/auth-context";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldAlert, Activity, FileJson, ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { FilterSortBar } from "@/components/filter-sort-bar";
import { formatDate } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export default function AuditPage() {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const limit = 50;
  const [search, setSearch] = useState("");
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});
  const [selectedDetails, setSelectedDetails] = useState<any>(null);

  const params = {
    limit,
    offset: (page - 1) * limit,
    q: search || undefined,
    action: activeFilters.action || undefined,
  };

  const { data: actions = [] } = useListAuditActions({
    query: {
      enabled: user?.role === "admin",
      queryKey: getListAuditActionsQueryKey()
    }
  });

  const { data: pageData, isLoading } = useListAuditLog(params, {
    query: {
      enabled: user?.role === "admin",
      queryKey: getListAuditLogQueryKey(params),
      placeholderData: (prev: any) => prev
    }
  });

  if (user?.role !== "admin") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <ShieldAlert className="w-16 h-16 text-destructive mb-4" />
        <h2 className="text-2xl font-bold">Access Denied</h2>
        <p className="text-muted-foreground mt-2">You must be an administrator to view the audit log.</p>
      </div>
    );
  }

  const items = pageData?.items || [];
  const total = pageData?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Activity className="w-7 h-7 text-primary" />
            Audit Trail
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Fleet-wide activity logs. Events are retained for 90 days.
          </p>
        </div>
      </div>

      <FilterSortBar
        searchValue={search}
        onSearchChange={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search user or resource..."
        filters={[
          {
            key: "action",
            label: "Action",
            type: "select",
            options: actions.map((a: string) => ({ value: a, label: a }))
          }
        ]}
        activeFilters={activeFilters}
        onFilterChange={(k, v) => {
          setActiveFilters(prev => ({ ...prev, [k]: v as string }));
          setPage(1);
        }}
      />

      <Card className="glass-panel overflow-hidden">
        <CardContent className="p-0">
          {isLoading && items.length === 0 ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : items.length === 0 ? (
            <div className="p-12 text-center">
              <FileText className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground">No audit entries found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-muted-foreground border-b border-white/5 bg-black/20">
                  <tr>
                    <th className="px-6 py-3 text-left">Timestamp</th>
                    <th className="px-6 py-3 text-left">User</th>
                    <th className="px-6 py-3 text-left">IP Address</th>
                    <th className="px-6 py-3 text-left">Action</th>
                    <th className="px-6 py-3 text-left">Resource</th>
                    <th className="px-6 py-3 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {items.map((item: any) => (
                    <tr key={item.id} className="hover:bg-white/[0.02]">
                      <td className="px-6 py-3 text-muted-foreground whitespace-nowrap">
                        {formatDate(item.createdAt)}
                      </td>
                      <td className="px-6 py-3 font-medium">
                        {item.username}
                      </td>
                      <td className="px-6 py-3 font-mono text-xs text-muted-foreground">
                        {item.ip || "—"}
                      </td>
                      <td className="px-6 py-3">
                        <Badge variant="outline" className="font-mono text-[10px] bg-primary/5 text-primary border-primary/20">
                          {item.action}
                        </Badge>
                      </td>
                      <td className="px-6 py-3">
                        {item.resourceType ? (
                          <div className="flex flex-col">
                            <span className="font-medium text-foreground">{item.resourceName || item.resourceId}</span>
                            <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">{item.resourceType}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>
                      <td className="px-6 py-3 text-right">
                        {item.details && Object.keys(item.details).length > 0 ? (
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-primary hover:text-primary hover:bg-primary/10" onClick={() => setSelectedDetails(item.details)}>
                            <FileJson className="w-4 h-4" />
                          </Button>
                        ) : (
                          <span className="text-muted-foreground/40 text-xs px-3">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          
          {totalPages > 1 && (
            <div className="p-4 border-t border-white/5 flex items-center justify-between text-sm bg-black/10">
              <div className="text-muted-foreground">
                Showing {items.length} of {total} entries
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <div className="flex items-center px-4 font-mono text-xs font-medium">
                  {page} / {totalPages}
                </div>
                <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selectedDetails} onOpenChange={(open) => !open && setSelectedDetails(null)}>
        <DialogContent className="max-w-2xl bg-card">
          <DialogHeader>
            <DialogTitle>Audit Details</DialogTitle>
            <DialogDescription>Complete recorded detail for this audit entry.</DialogDescription>
          </DialogHeader>
          <div className="bg-black/60 rounded-md p-4 overflow-auto max-h-[60vh] border border-white/10 shadow-inner">
            <pre className="text-xs font-mono text-primary/80">
              {JSON.stringify(selectedDetails, null, 2)}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
