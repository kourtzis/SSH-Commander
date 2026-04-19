import { useState, useRef, useMemo } from "react";
import { useListRouters, useImportRouters, useGetRoutersUptime, useFingerprintRouter, useFingerprintAllRouters, useListCredentialProfiles } from "@workspace/api-client-react";
import { Link } from "wouter";
import { useRoutersMutations } from "@/hooks/use-mutations";
import { useSelection } from "@/hooks/use-selection";
import { useConfirm } from "@/components/confirm-dialog";
import { SelectionBar } from "@/components/selection-bar";
import { FilterSortBar, ActiveSort, applySort } from "@/components/filter-sort-bar";
import { SavedViews } from "@/components/saved-views";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Server, Edit2, Trash2, Upload, FileSpreadsheet, CheckCircle2, XCircle, AlertTriangle, Activity, Fingerprint, Terminal as TerminalIcon, Loader2, KeyRound } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { customFetch } from "@workspace/api-client-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate } from "@/lib/utils";

const routerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  ipAddress: z.string().min(1, "IP is required"),
  sshPort: z.coerce.number().min(1).max(65535),
  sshUsername: z.string().min(1, "Username is required"),
  sshPassword: z.string().optional(),
  description: z.string().optional(),
  credentialProfileId: z.number().nullable().optional(),
});

type FormData = z.infer<typeof routerSchema>;

const EXPECTED_COLUMNS = ["name", "ipAddress", "sshPort", "sshUsername", "sshPassword", "description"];

const COLUMN_ALIASES: Record<string, string> = {
  "name": "name",
  "device_name": "name",
  "device name": "name",
  "hostname": "name",
  "router_name": "name",
  "router name": "name",
  "ip": "ipAddress",
  "ip_address": "ipAddress",
  "ip address": "ipAddress",
  "ipaddress": "ipAddress",
  "address": "ipAddress",
  "host": "ipAddress",
  "port": "sshPort",
  "ssh_port": "sshPort",
  "ssh port": "sshPort",
  "sshport": "sshPort",
  "username": "sshUsername",
  "ssh_username": "sshUsername",
  "ssh username": "sshUsername",
  "sshusername": "sshUsername",
  "user": "sshUsername",
  "password": "sshPassword",
  "ssh_password": "sshPassword",
  "ssh password": "sshPassword",
  "sshpassword": "sshPassword",
  "pass": "sshPassword",
  "description": "description",
  "desc": "description",
  "notes": "description",
  "note": "description",
  "comment": "description",
};

function mapColumnName(header: string): string | null {
  const lower = header.toLowerCase().trim();
  if (EXPECTED_COLUMNS.includes(lower)) return lower;
  return COLUMN_ALIASES[lower] || null;
}

interface ParsedRow {
  name: string;
  ipAddress: string;
  sshPort?: number;
  sshUsername?: string;
  sshPassword?: string;
  description?: string;
  valid: boolean;
  error?: string;
}

function parseFileData(rawRows: Record<string, string>[]): { rows: ParsedRow[]; columnMap: Record<string, string> } {
  if (rawRows.length === 0) return { rows: [], columnMap: {} };

  const headers = Object.keys(rawRows[0]);
  const columnMap: Record<string, string> = {};
  for (const h of headers) {
    const mapped = mapColumnName(h);
    if (mapped) columnMap[h] = mapped;
  }

  const rows: ParsedRow[] = rawRows.map((raw) => {
    const mapped: Record<string, string> = {};
    for (const [orig, target] of Object.entries(columnMap)) {
      if (raw[orig] !== undefined && raw[orig] !== "") {
        mapped[target] = raw[orig];
      }
    }
    const name = (mapped.name || "").trim();
    const ipAddress = (mapped.ipAddress || "").trim();
    const valid = !!name && !!ipAddress;
    return {
      name,
      ipAddress,
      sshPort: mapped.sshPort ? parseInt(mapped.sshPort) || 22 : undefined,
      sshUsername: mapped.sshUsername?.trim() || undefined,
      sshPassword: mapped.sshPassword?.trim() || undefined,
      description: mapped.description?.trim() || undefined,
      valid,
      error: !name ? "Missing name" : !ipAddress ? "Missing IP" : undefined,
    };
  });

  return { rows, columnMap };
}

// Sparkline now reads its daily series from the prop populated by the bulk
// /routers/uptime call instead of firing its own per-row HTTP request. Avoids
// N parallel API calls on the Devices page (v1.7.1 perf fix).
function UptimeSparkline({ points }: { points: Array<{ totalChecks: number; successCount: number }> }) {
  if (points.length === 0) {
    return <span className="text-xs text-muted-foreground/40">no data</span>;
  }
  const w = 80, h = 20;
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const path = points
    .map((p, i) => {
      const pct = p.totalChecks > 0 ? (p.successCount / p.totalChecks) * 100 : 0;
      const x = i * step;
      const y = h - (pct / 100) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <svg width={w} height={h} className="inline-block align-middle">
          <path d={path} stroke="currentColor" strokeWidth={1.5} fill="none" className="text-emerald-400" />
        </svg>
      </TooltipTrigger>
      <TooltipContent>
        <span className="text-xs">{points.length}-day reachability history</span>
      </TooltipContent>
    </Tooltip>
  );
}

function UptimeCell({ percent, days }: { percent: number | undefined; days: Array<{ totalChecks: number; successCount: number }> | undefined }) {
  const pct = typeof percent === "number" ? percent : null;
  const color = pct === null ? "text-muted-foreground/40" : pct >= 99 ? "text-emerald-400" : pct >= 90 ? "text-amber-400" : "text-destructive";
  return (
    <div className="flex items-center gap-2">
      <span className={`text-xs font-mono w-12 ${color}`}>{pct === null ? "—" : `${pct.toFixed(1)}%`}</span>
      <UptimeSparkline points={days ?? []} />
    </div>
  );
}

export default function Routers() {
  const { user } = useAuth();
  const { data: routers = [], isLoading } = useListRouters();
  const { data: uptimeMap } = useGetRoutersUptime();
  const { createRouter, updateRouter, deleteRouter } = useRoutersMutations();
  const importRouters = useImportRouters();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ActiveSort>({ key: "name", dir: "asc" });
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingRouter, setEditingRouter] = useState<number | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importStep, setImportStep] = useState<"upload" | "preview" | "results">("upload");
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
  const [fileName, setFileName] = useState("");
  const [importResults, setImportResults] = useState<{ created: number; failed: number; total: number; results: any[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<FormData>({
    resolver: zodResolver(routerSchema),
    defaultValues: { sshPort: 22 }
  });

  const filteredRouters = useMemo(() => {
    let result = routers.filter(r =>
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.ipAddress.includes(search)
    );
    return applySort(result, sort, {
      name: (r) => r.name,
      ip: (r) => r.ipAddress,
      date: (r) => new Date(r.createdAt),
    });
  }, [routers, search, sort]);

  const selection = useSelection(filteredRouters.map(r => r.id));

  const handleOpenDialog = (router?: any) => {
    if (router) {
      setEditingRouter(router.id);
      form.reset({
        name: router.name,
        ipAddress: router.ipAddress,
        sshPort: router.sshPort,
        sshUsername: router.sshUsername,
        description: router.description || "",
        credentialProfileId: router.credentialProfileId ?? null,
      });
    } else {
      setEditingRouter(null);
      form.reset({ name: "", ipAddress: "", sshPort: 22, sshUsername: "admin", description: "", credentialProfileId: null });
    }
    setIsDialogOpen(true);
  };

  const onSubmit = async (data: FormData) => {
    try {
      if (editingRouter) {
        await updateRouter.mutateAsync({ id: editingRouter, data });
        toast({ title: "Device updated successfully" });
      } else {
        await createRouter.mutateAsync({ data });
        toast({ title: "Device created successfully" });
      }
      setIsDialogOpen(false);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: number) => {
    const ok = await confirm({ title: "Delete Device", description: "Are you sure you want to delete this device? This action cannot be undone.", confirmLabel: "Delete", variant: "destructive" });
    if (!ok) return;
    try {
      await deleteRouter.mutateAsync({ id });
      toast({ title: "Device deleted" });
    } catch (err: any) {
      toast({ title: "Error deleting device", description: err.message, variant: "destructive" });
    }
  };

  const handleBulkDelete = async () => {
    const ok = await confirm({ title: "Delete Devices", description: `Delete ${selection.count} selected device(s)? This action cannot be undone.`, confirmLabel: "Delete All", variant: "destructive" });
    if (!ok) return;
    setIsBulkDeleting(true);
    try {
      await Promise.all(selection.ids.map(id => deleteRouter.mutateAsync({ id })));
      toast({ title: `${selection.count} device(s) deleted` });
      selection.clear();
    } catch (err: any) {
      toast({ title: "Error deleting devices", description: err.message, variant: "destructive" });
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const openImportDialog = () => {
    setImportStep("upload");
    setParsedRows([]);
    setColumnMap({});
    setFileName("");
    setImportResults(null);
    setIsImportOpen(true);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);

    try {
      const ExcelJS = (await import("exceljs")).default;
      const isCSV = file.name.toLowerCase().endsWith(".csv");
      const wb = new ExcelJS.Workbook();

      if (isCSV) {
        const text = await file.text();
        const buffer = new TextEncoder().encode(text);
        await wb.csv.read(new Blob([buffer]).stream() as any);
      } else {
        const arrayBuffer = await file.arrayBuffer();
        await wb.xlsx.load(arrayBuffer);
      }

      const ws = wb.worksheets[0];
      if (!ws) return;

      const headers: string[] = [];
      ws.getRow(1).eachCell((cell, colNumber) => {
        headers[colNumber - 1] = String(cell.value ?? "").trim();
      });

      const rawRows: Record<string, string>[] = [];
      for (let i = 2; i <= ws.rowCount; i++) {
        const row = ws.getRow(i);
        const obj: Record<string, string> = {};
        let hasValue = false;
        headers.forEach((h, idx) => {
          const val = String(row.getCell(idx + 1).value ?? "").trim();
          obj[h] = val;
          if (val) hasValue = true;
        });
        if (hasValue) rawRows.push(obj);
      }

      const { rows, columnMap: cm } = parseFileData(rawRows);
      setParsedRows(rows);
      setColumnMap(cm);
      setImportStep("preview");
    } catch {
      toast({ title: "Error parsing file", variant: "destructive" });
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleImport = async () => {
    const validRows = parsedRows.filter(r => r.valid);
    if (validRows.length === 0) return;

    try {
      const res = await importRouters.mutateAsync({
        data: {
          routers: validRows.map(r => ({
            name: r.name,
            ipAddress: r.ipAddress,
            sshPort: r.sshPort,
            sshUsername: r.sshUsername,
            sshPassword: r.sshPassword,
            description: r.description,
          })),
        },
      });
      setImportResults(res);
      setImportStep("results");
      queryClient.invalidateQueries({ queryKey: ["/api/routers"] });
      if (res.created > 0) {
        toast({ title: `Imported ${res.created} device(s)` });
      }
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    }
  };

  const validCount = parsedRows.filter(r => r.valid).length;
  const invalidCount = parsedRows.filter(r => !r.valid).length;

  return (
    <TooltipProvider>
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Devices</h1>
          <p className="text-muted-foreground mt-1">Manage your SSH-enabled devices for batch jobs.</p>
        </div>
        <div className="flex gap-2">
          <FingerprintAllButton />
          <Button variant="outline" onClick={openImportDialog} className="gap-2">
            <Upload className="w-4 h-4" /> Import
          </Button>
          <Button onClick={() => handleOpenDialog()} className="gap-2">
            <Plus className="w-4 h-4" /> Add Device
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-2">
        <div className="flex-1">
          <FilterSortBar
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search by name or IP..."
            sortOptions={[
              { key: "name", label: "Name" },
              { key: "ip", label: "IP" },
              { key: "date", label: "Added" },
            ]}
            activeSort={sort}
            onSortChange={setSort}
          />
        </div>
        <SavedViews
          pageKey="devices"
          currentState={{ search, sort }}
          onApply={(s: any) => {
            if (typeof s?.search === "string") setSearch(s.search);
            if (s?.sort) setSort(s.sort);
          }}
        />
      </div>

      <SelectionBar count={selection.count} label="devices" onDelete={handleBulkDelete} onClear={selection.clear} isDeleting={isBulkDeleting} />

      <Card className="glass-panel">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-6 py-3">
                  <Skeleton className="h-4 w-4 rounded" />
                  <Skeleton className="h-8 w-8 rounded-lg" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>
          ) : filteredRouters.length === 0 ? (
            <div className="p-12 flex flex-col items-center justify-center text-center">
              <Server className="w-12 h-12 text-muted-foreground/30 mb-4" />
              <p className="text-lg font-medium text-foreground">No devices found</p>
              <p className="text-sm text-muted-foreground mt-1">Add a device to get started.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-muted-foreground uppercase bg-black/40 border-b border-border/50">
                  <tr>
                    <th className="px-4 py-4 w-10">
                      <Checkbox
                        checked={selection.isAllSelected}
                        onCheckedChange={selection.toggleAll}
                        aria-label="Select all"
                        {...(selection.isSomeSelected ? { "data-state": "indeterminate" as any } : {})}
                      />
                    </th>
                    <th className="px-6 py-4 font-medium">Name</th>
                    <th className="px-6 py-4 font-medium">IP Address</th>
                    <th className="px-6 py-4 font-medium">SSH Config</th>
                    <th className="px-6 py-4 font-medium">Vendor / Model / OS</th>
                    <th className="px-6 py-4 font-medium">
                      <span className="inline-flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" /> Uptime (30d)</span>
                    </th>
                    <th className="px-6 py-4 font-medium">Added</th>
                    <th className="px-6 py-4 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {filteredRouters.map((router) => (
                    <tr key={router.id} className={`hover:bg-white/5 transition-colors ${selection.selected.has(router.id) ? "bg-primary/10" : ""}`}>
                      <td className="px-4 py-4">
                        <Checkbox
                          checked={selection.selected.has(router.id)}
                          onCheckedChange={() => selection.toggle(router.id)}
                          aria-label={`Select ${router.name}`}
                        />
                      </td>
                      <td className="px-6 py-4 font-medium text-foreground">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                            <Server className="w-4 h-4" />
                          </div>
                          <div>
                            {router.name}
                            {router.description && <p className="text-xs text-muted-foreground font-normal mt-0.5">{router.description}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 font-mono text-muted-foreground">{router.ipAddress}</td>
                      <td className="px-6 py-4">
                        <span className="text-muted-foreground">{router.sshUsername}</span>
                        <span className="text-foreground/20 mx-2">@</span>
                        <span className="font-mono text-muted-foreground">port {router.sshPort}</span>
                      </td>
                      <td className="px-6 py-4 text-sm">
                        {(router as any).vendor ? (
                          <div>
                            <div className="font-medium text-foreground capitalize">{(router as any).vendor}</div>
                            {(router as any).model && (
                              <div className="text-xs text-foreground/80 font-mono truncate max-w-[180px]">{(router as any).model}</div>
                            )}
                            {(router as any).osVersion && (
                              <div className="text-xs text-muted-foreground truncate max-w-[180px]">{(router as any).osVersion}</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground/60 text-xs italic">unknown</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <UptimeCell
                          percent={(uptimeMap as any)?.[String(router.id)]?.uptimePercent}
                          days={(uptimeMap as any)?.[String(router.id)]?.days}
                        />
                      </td>
                      <td className="px-6 py-4 text-muted-foreground">{formatDate(router.createdAt).split(' ')[0]}</td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex justify-end gap-1">
                          <FingerprintRowButton routerId={router.id} />
                          {(user?.role === "admin" || (user as any)?.canTerminal) && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Link href={`/routers/${router.id}/terminal`}>
                                  <Button variant="ghost" size="icon" data-testid={`terminal-button-${router.id}`}>
                                    <TerminalIcon className="w-4 h-4" />
                                  </Button>
                                </Link>
                              </TooltipTrigger>
                              <TooltipContent>Open terminal</TooltipContent>
                            </Tooltip>
                          )}
                          {user?.role === "admin" && (
                            <RepinHostKeyButton routerId={router.id} pinnedFingerprint={(router as any).sshHostKeyFingerprint ?? null} />
                          )}
                          <Button variant="ghost" size="icon" onClick={() => handleOpenDialog(router)}>
                            <Edit2 className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(router.id)}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingRouter ? "Edit Device" : "Add Device"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input {...form.register("name")} placeholder="Core Switch 1" />
            </div>
            <div className="space-y-2">
              <Label>IP Address</Label>
              <Input {...form.register("ipAddress")} placeholder="192.168.1.1" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>SSH Username</Label>
                <Input {...form.register("sshUsername")} />
              </div>
              <div className="space-y-2">
                <Label>SSH Port</Label>
                <Input type="number" {...form.register("sshPort")} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>SSH Password {editingRouter && <span className="text-muted-foreground text-xs">(Leave blank to keep unchanged)</span>}</Label>
              <Input type="password" {...form.register("sshPassword")} placeholder="••••••••" />
            </div>
            <CredentialProfileField
              value={(form.watch as any)("credentialProfileId") ?? null}
              onChange={(v) => (form.setValue as any)("credentialProfileId", v)}
            />
            <div className="space-y-2">
              <Label>Description (Optional)</Label>
              <Input {...form.register("description")} placeholder="Datacenter rack 4" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={createRouter.isPending || updateRouter.isPending}>
                Save Device
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={isImportOpen} onOpenChange={setIsImportOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-primary" />
              Import Devices
            </DialogTitle>
          </DialogHeader>

          {importStep === "upload" && (
            <div className="py-6">
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileSelect}
                className="hidden"
              />
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-white/10 rounded-xl p-12 flex flex-col items-center gap-4 cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-all"
              >
                <Upload className="w-10 h-10 text-muted-foreground" />
                <div className="text-center">
                  <p className="text-lg font-medium">Drop a file or click to browse</p>
                  <p className="text-sm text-muted-foreground mt-1">Supports .xlsx, .xls, and .csv files</p>
                </div>
              </div>
              <div className="mt-6 p-4 bg-black/20 rounded-lg border border-white/5 space-y-4">
                <div>
                  <p className="text-sm font-medium mb-2">Expected columns:</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                    <div><code className="text-primary">name</code> <span className="text-muted-foreground">(required)</span></div>
                    <div><code className="text-primary">ipAddress</code> <span className="text-muted-foreground">(required)</span></div>
                    <div><code className="text-primary">sshUsername</code> <span className="text-muted-foreground">(default: admin)</span></div>
                    <div><code className="text-primary">sshPort</code> <span className="text-muted-foreground">(default: 22)</span></div>
                    <div><code className="text-primary">sshPassword</code></div>
                    <div><code className="text-primary">description</code></div>
                  </div>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">Accepted column name variations:</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
                    <div>
                      <span className="text-muted-foreground">Name:</span>{" "}
                      <code className="text-primary/70">name</code>, <code className="text-primary/70">hostname</code>, <code className="text-primary/70">device_name</code>, <code className="text-primary/70">device name</code>, <code className="text-primary/70">router_name</code>, <code className="text-primary/70">router name</code>
                    </div>
                    <div>
                      <span className="text-muted-foreground">IP Address:</span>{" "}
                      <code className="text-primary/70">ipAddress</code>, <code className="text-primary/70">ip</code>, <code className="text-primary/70">ip_address</code>, <code className="text-primary/70">ip address</code>, <code className="text-primary/70">address</code>, <code className="text-primary/70">host</code>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Username:</span>{" "}
                      <code className="text-primary/70">sshUsername</code>, <code className="text-primary/70">username</code>, <code className="text-primary/70">ssh_username</code>, <code className="text-primary/70">ssh username</code>, <code className="text-primary/70">user</code>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Port:</span>{" "}
                      <code className="text-primary/70">sshPort</code>, <code className="text-primary/70">port</code>, <code className="text-primary/70">ssh_port</code>, <code className="text-primary/70">ssh port</code>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Password:</span>{" "}
                      <code className="text-primary/70">sshPassword</code>, <code className="text-primary/70">password</code>, <code className="text-primary/70">ssh_password</code>, <code className="text-primary/70">ssh password</code>, <code className="text-primary/70">pass</code>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Description:</span>{" "}
                      <code className="text-primary/70">description</code>, <code className="text-primary/70">desc</code>, <code className="text-primary/70">notes</code>, <code className="text-primary/70">note</code>, <code className="text-primary/70">comment</code>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {importStep === "preview" && (
            <div className="space-y-4 py-2">
              <div className="flex items-center gap-4">
                <FileSpreadsheet className="w-5 h-5 text-muted-foreground" />
                <span className="text-sm font-medium">{fileName}</span>
              </div>

              <div className="flex gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>{validCount} valid</span>
                </div>
                {invalidCount > 0 && (
                  <div className="flex items-center gap-2 text-destructive">
                    <XCircle className="w-4 h-4" />
                    <span>{invalidCount} invalid</span>
                  </div>
                )}
              </div>

              {Object.keys(columnMap).length > 0 && (
                <div className="text-xs text-muted-foreground space-y-1">
                  <p className="font-medium">Column mapping:</p>
                  {Object.entries(columnMap).map(([from, to]) => (
                    <span key={from} className="inline-block mr-3">
                      <code className="text-muted-foreground">{from}</code> → <code className="text-primary">{to}</code>
                    </span>
                  ))}
                </div>
              )}

              <div className="overflow-x-auto rounded-xl border border-white/5 max-h-[300px]">
                <table className="w-full text-xs text-left">
                  <thead className="bg-black/40 text-muted-foreground sticky top-0">
                    <tr>
                      <th className="px-3 py-2 w-8">#</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">IP</th>
                      <th className="px-3 py-2">Username</th>
                      <th className="px-3 py-2">Port</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {parsedRows.map((row, i) => (
                      <tr key={i} className={row.valid ? "" : "bg-destructive/5"}>
                        <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                        <td className="px-3 py-2">
                          {row.valid ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <span className="flex items-center gap-1 text-destructive">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              <span>{row.error}</span>
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-medium">{row.name || "-"}</td>
                        <td className="px-3 py-2 font-mono">{row.ipAddress || "-"}</td>
                        <td className="px-3 py-2">{row.sshUsername || "admin"}</td>
                        <td className="px-3 py-2">{row.sshPort || 22}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setImportStep("upload")}>Back</Button>
                <Button onClick={handleImport} disabled={validCount === 0 || importRouters.isPending}>
                  Import {validCount} Device{validCount !== 1 ? "s" : ""}
                </Button>
              </DialogFooter>
            </div>
          )}

          {importStep === "results" && importResults && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                  <p className="text-2xl font-bold text-emerald-400">{importResults.created}</p>
                  <p className="text-xs text-muted-foreground mt-1">Created</p>
                </div>
                <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20">
                  <p className="text-2xl font-bold text-destructive">{importResults.failed}</p>
                  <p className="text-xs text-muted-foreground mt-1">Failed</p>
                </div>
                <div className="p-4 rounded-xl bg-black/20 border border-white/5">
                  <p className="text-2xl font-bold">{importResults.total}</p>
                  <p className="text-xs text-muted-foreground mt-1">Total</p>
                </div>
              </div>

              {importResults.results.some((r: any) => r.error) && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-destructive">Errors:</p>
                  <div className="max-h-32 overflow-y-auto space-y-1">
                    {importResults.results.filter((r: any) => r.error).map((r: any, i: number) => (
                      <div key={i} className="text-xs flex items-center gap-2 text-destructive/80">
                        <XCircle className="w-3 h-3 shrink-0" />
                        <span>{r.name}: {r.error}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <DialogFooter>
                <Button onClick={() => setIsImportOpen(false)}>Done</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}

// Per-row Fingerprint button. Triggers `POST /routers/:id/fingerprint`,
// shows a spinner while in flight, and refreshes the list on success so the
// new vendor/OS values appear immediately.
// Admin-only "Re-pin host key" button. Clears the device's pinned SSH host
// key fingerprint so the next connection re-pins via TOFU. Use after a
// device legitimately rotated its key (factory reset, OS upgrade, etc).
// When no key is pinned yet, the button is shown disabled with a tooltip.
function RepinHostKeyButton({ routerId, pinnedFingerprint }: { routerId: number; pinnedFingerprint: string | null }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const isPinned = Boolean(pinnedFingerprint);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={busy || !isPinned}
          onClick={async () => {
            const ok = await confirm({
              title: "Re-pin SSH host key?",
              description: `The pinned fingerprint will be cleared and the next connection will trust whatever key the device presents. Only do this if you have an out-of-band reason to believe the device's key legitimately changed.\n\nCurrent pin: ${pinnedFingerprint}`,
              confirmLabel: "Re-pin",
              variant: "destructive",
            });
            if (!ok) return;
            setBusy(true);
            try {
              await customFetch(`${import.meta.env.BASE_URL}api/routers/${routerId}/repin-host-key`, { method: "POST" });
              toast({ title: "Host key cleared", description: "The next connection will re-pin." });
              await queryClient.invalidateQueries({ queryKey: ["/api/routers"] });
            } catch (err: any) {
              toast({ title: "Re-pin failed", description: String(err?.message || err), variant: "destructive" });
            } finally {
              setBusy(false);
            }
          }}
          data-testid={`repin-button-${routerId}`}
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{isPinned ? "Re-pin SSH host key (clear current pin)" : "No host key pinned yet"}</TooltipContent>
    </Tooltip>
  );
}

function FingerprintRowButton({ routerId }: { routerId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const mut = useFingerprintRouter();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={mut.isPending}
          onClick={async () => {
            try {
              const res: any = await mut.mutateAsync({ id: routerId } as any);
              toast({
                title: res?.vendor ? `Detected ${res.vendor}` : "Fingerprint complete",
                description: [res?.model, res?.osVersion].filter(Boolean).join(" — ") || "Device probed",
              });
              await queryClient.invalidateQueries({ queryKey: ["/api/routers"] });
            } catch (err: any) {
              toast({ title: "Fingerprint failed", description: String(err?.message || err), variant: "destructive" });
            }
          }}
          data-testid={`fingerprint-button-${routerId}`}
        >
          {mut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Fingerprint className="w-4 h-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Detect vendor / OS</TooltipContent>
    </Tooltip>
  );
}

// Header-level "Fingerprint All" button. Hits the bulk endpoint that probes
// every device server-side and returns a summary count. We invalidate the
// device list so all the new vendor/OS columns repaint at once.
function FingerprintAllButton() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const mut = useFingerprintAllRouters();
  return (
    <Button
      variant="outline"
      className="gap-2"
      disabled={mut.isPending}
      onClick={async () => {
        try {
          const res: any = await mut.mutateAsync({} as any);
          const ok = res?.successCount ?? res?.detected ?? 0;
          const bad = res?.failedCount ?? res?.failed ?? 0;
          toast({
            title: "Fingerprint complete",
            description: `${ok} detected, ${bad} failed`,
          });
          await queryClient.invalidateQueries({ queryKey: ["/api/routers"] });
        } catch (err: any) {
          toast({ title: "Fingerprint failed", description: String(err?.message || err), variant: "destructive" });
        }
      }}
      data-testid="fingerprint-all-button"
    >
      {mut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Fingerprint className="w-4 h-4" />}
      Fingerprint All
    </Button>
  );
}

// Credential profile selector inside the device dialog. Lists profiles defined
// on /credentials and lets the operator attach one to this device. Picking
// "None" clears the FK and the inline username/password on this row become the
// effective credentials.
function CredentialProfileField({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const { data: profiles = [] } = useListCredentialProfiles();
  return (
    <div className="space-y-2">
      <Label>Credential Profile (Optional)</Label>
      <Select
        value={value == null ? "none" : String(value)}
        onValueChange={(v) => onChange(v === "none" ? null : Number(v))}
      >
        <SelectTrigger data-testid="credential-profile-select">
          <SelectValue placeholder="Use inline credentials" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Use inline credentials</SelectItem>
          {profiles.map((p: any) => (
            <SelectItem key={p.id} value={String(p.id)}>
              {p.name} ({p.sshUsername})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        When a profile is selected, its credentials are used and the inline username/password below act as overrides only if filled in.
      </p>
    </div>
  );
}
