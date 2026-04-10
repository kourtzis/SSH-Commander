import { useState, useRef, useMemo } from "react";
import { useListRouters, useImportRouters } from "@workspace/api-client-react";
import { useRoutersMutations } from "@/hooks/use-mutations";
import { useSelection } from "@/hooks/use-selection";
import { SelectionBar } from "@/components/selection-bar";
import { FilterSortBar, ActiveSort, applySort } from "@/components/filter-sort-bar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Server, Edit2, Trash2, Upload, FileSpreadsheet, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate } from "@/lib/utils";
import * as XLSX from "xlsx";

const routerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  ipAddress: z.string().min(1, "IP is required"),
  sshPort: z.coerce.number().min(1).max(65535),
  sshUsername: z.string().min(1, "Username is required"),
  sshPassword: z.string().optional(),
  description: z.string().optional(),
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

export default function Routers() {
  const { data: routers = [], isLoading } = useListRouters();
  const { createRouter, updateRouter, deleteRouter } = useRoutersMutations();
  const importRouters = useImportRouters();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
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
      });
    } else {
      setEditingRouter(null);
      form.reset({ name: "", ipAddress: "", sshPort: 22, sshUsername: "admin", description: "" });
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
    if (confirm("Are you sure you want to delete this device?")) {
      try {
        await deleteRouter.mutateAsync({ id });
        toast({ title: "Device deleted" });
      } catch (err: any) {
        toast({ title: "Error deleting device", description: err.message, variant: "destructive" });
      }
    }
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selection.count} selected device(s)?`)) return;
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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);

    const reader = new FileReader();
    const isCSV = file.name.toLowerCase().endsWith(".csv");

    if (isCSV) {
      reader.onload = (evt) => {
        const text = evt.target?.result as string;
        const wb = XLSX.read(text, { type: "string" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });
        const { rows, columnMap: cm } = parseFileData(rawRows);
        setParsedRows(rows);
        setColumnMap(cm);
        setImportStep("preview");
      };
      reader.readAsText(file);
    } else {
      reader.onload = (evt) => {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });
        const { rows, columnMap: cm } = parseFileData(rawRows);
        setParsedRows(rows);
        setColumnMap(cm);
        setImportStep("preview");
      };
      reader.readAsArrayBuffer(file);
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
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Devices</h1>
          <p className="text-muted-foreground mt-1">Manage your SSH-enabled devices for batch jobs.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={openImportDialog} className="gap-2">
            <Upload className="w-4 h-4" /> Import
          </Button>
          <Button onClick={() => handleOpenDialog()} className="gap-2">
            <Plus className="w-4 h-4" /> Add Device
          </Button>
        </div>
      </div>

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

      <SelectionBar count={selection.count} label="devices" onDelete={handleBulkDelete} onClear={selection.clear} isDeleting={isBulkDeleting} />

      <Card className="glass-panel">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading devices...</div>
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
                    <th className="px-6 py-4 font-medium">Added</th>
                    <th className="px-6 py-4 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {filteredRouters.map((router) => (
                    <tr key={router.id} className={`hover:bg-white/5 transition-colors ${selection.selected.has(router.id) ? "bg-primary/5" : ""}`}>
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
                        <span className="text-white/20 mx-2">@</span>
                        <span className="font-mono text-muted-foreground">port {router.sshPort}</span>
                      </td>
                      <td className="px-6 py-4 text-muted-foreground">{formatDate(router.createdAt).split(' ')[0]}</td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex justify-end gap-2">
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
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <FileSpreadsheet className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{fileName}</p>
                    <p className="text-xs text-muted-foreground">{parsedRows.length} row(s) found</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  {validCount > 0 && (
                    <span className="flex items-center gap-1 text-emerald-400">
                      <CheckCircle2 className="w-4 h-4" /> {validCount} valid
                    </span>
                  )}
                  {invalidCount > 0 && (
                    <span className="flex items-center gap-1 text-red-400">
                      <XCircle className="w-4 h-4" /> {invalidCount} invalid
                    </span>
                  )}
                </div>
              </div>

              {Object.keys(columnMap).length > 0 && (
                <div className="p-3 bg-black/20 rounded-lg border border-white/5">
                  <p className="text-xs font-medium mb-2 text-muted-foreground">Column mapping:</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(columnMap).map(([from, to]) => (
                      <span key={from} className="text-xs bg-primary/10 text-primary px-2 py-1 rounded">
                        {from} → {to}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {Object.keys(columnMap).length === 0 && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-3">
                  <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
                  <p className="text-sm text-red-300">No matching columns found. Make sure your file has columns like "name", "ip" or "ipAddress".</p>
                </div>
              )}

              <div className="overflow-x-auto border border-white/5 rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-black/40 text-muted-foreground uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left w-8">#</th>
                      <th className="px-3 py-2 text-left">Status</th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-left">IP Address</th>
                      <th className="px-3 py-2 text-left">Username</th>
                      <th className="px-3 py-2 text-left">Port</th>
                      <th className="px-3 py-2 text-left">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {parsedRows.slice(0, 100).map((row, i) => (
                      <tr key={i} className={row.valid ? "" : "bg-red-500/5"}>
                        <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                        <td className="px-3 py-2">
                          {row.valid ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <span className="text-red-400 text-xs">{row.error}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-medium">{row.name || "—"}</td>
                        <td className="px-3 py-2 font-mono">{row.ipAddress || "—"}</td>
                        <td className="px-3 py-2">{row.sshUsername || "admin"}</td>
                        <td className="px-3 py-2">{row.sshPort || 22}</td>
                        <td className="px-3 py-2 text-muted-foreground truncate max-w-[150px]">{row.description || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsedRows.length > 100 && (
                  <p className="text-xs text-muted-foreground text-center py-2">Showing first 100 of {parsedRows.length} rows</p>
                )}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setImportStep("upload")}>Back</Button>
                <Button
                  onClick={handleImport}
                  disabled={validCount === 0 || importRouters.isPending}
                  className="gap-2"
                >
                  {importRouters.isPending ? "Importing..." : `Import ${validCount} Device(s)`}
                </Button>
              </DialogFooter>
            </div>
          )}

          {importStep === "results" && importResults && (
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-3 gap-4">
                <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-center">
                  <p className="text-2xl font-bold text-emerald-400">{importResults.created}</p>
                  <p className="text-xs text-muted-foreground mt-1">Created</p>
                </div>
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-center">
                  <p className="text-2xl font-bold text-red-400">{importResults.failed}</p>
                  <p className="text-xs text-muted-foreground mt-1">Failed</p>
                </div>
                <div className="p-4 bg-white/5 border border-white/10 rounded-lg text-center">
                  <p className="text-2xl font-bold">{importResults.total}</p>
                  <p className="text-xs text-muted-foreground mt-1">Total</p>
                </div>
              </div>

              {importResults.results.some((r: any) => r.status === "error") && (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {importResults.results
                    .filter((r: any) => r.status === "error")
                    .map((r: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 text-xs p-2 bg-red-500/5 rounded">
                        <XCircle className="w-3 h-3 text-red-400 shrink-0" />
                        <span className="font-medium">{r.name}</span>
                        <span className="text-muted-foreground">— {r.error}</span>
                      </div>
                    ))}
                </div>
              )}

              <DialogFooter>
                <Button variant="outline" onClick={() => setIsImportOpen(false)}>Close</Button>
                <Button onClick={openImportDialog} className="gap-2">
                  <Upload className="w-4 h-4" /> Import More
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
