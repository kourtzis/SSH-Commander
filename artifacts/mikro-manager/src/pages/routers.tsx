import { useState } from "react";
import { useListRouters } from "@workspace/api-client-react";
import { useRoutersMutations } from "@/hooks/use-mutations";
import { useSelection } from "@/hooks/use-selection";
import { SelectionBar } from "@/components/selection-bar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Search, Server, Edit2, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/utils";

const routerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  ipAddress: z.string().min(1, "IP is required"),
  sshPort: z.coerce.number().min(1).max(65535),
  sshUsername: z.string().min(1, "Username is required"),
  sshPassword: z.string().optional(),
  description: z.string().optional(),
});

type FormData = z.infer<typeof routerSchema>;

export default function Routers() {
  const { data: routers = [], isLoading } = useListRouters();
  const { createRouter, updateRouter, deleteRouter } = useRoutersMutations();
  const { toast } = useToast();
  
  const [search, setSearch] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingRouter, setEditingRouter] = useState<number | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const form = useForm<FormData>({
    resolver: zodResolver(routerSchema),
    defaultValues: { sshPort: 22 }
  });

  const filteredRouters = routers.filter(r => 
    r.name.toLowerCase().includes(search.toLowerCase()) || 
    r.ipAddress.includes(search)
  );

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
        toast({ title: "Router updated successfully" });
      } else {
        await createRouter.mutateAsync({ data });
        toast({ title: "Router created successfully" });
      }
      setIsDialogOpen(false);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: number) => {
    if (confirm("Are you sure you want to delete this router?")) {
      try {
        await deleteRouter.mutateAsync({ id });
        toast({ title: "Router deleted" });
      } catch (err: any) {
        toast({ title: "Error deleting router", description: err.message, variant: "destructive" });
      }
    }
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selection.count} selected router(s)?`)) return;
    setIsBulkDeleting(true);
    try {
      await Promise.all(selection.ids.map(id => deleteRouter.mutateAsync({ id })));
      toast({ title: `${selection.count} router(s) deleted` });
      selection.clear();
    } catch (err: any) {
      toast({ title: "Error deleting routers", description: err.message, variant: "destructive" });
    } finally {
      setIsBulkDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Routers</h1>
          <p className="text-muted-foreground mt-1">Manage your Mikrotik devices for batch jobs.</p>
        </div>
        <Button onClick={() => handleOpenDialog()} className="gap-2">
          <Plus className="w-4 h-4" /> Add Router
        </Button>
      </div>

      <SelectionBar count={selection.count} label="routers" onDelete={handleBulkDelete} onClear={selection.clear} isDeleting={isBulkDeleting} />

      <Card className="glass-panel">
        <div className="p-4 border-b border-border/50 bg-black/20">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input 
              placeholder="Search by name or IP..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-black/40 border-white/5"
            />
          </div>
        </div>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading routers...</div>
          ) : filteredRouters.length === 0 ? (
            <div className="p-12 flex flex-col items-center justify-center text-center">
              <Server className="w-12 h-12 text-muted-foreground/30 mb-4" />
              <p className="text-lg font-medium text-foreground">No routers found</p>
              <p className="text-sm text-muted-foreground mt-1">Add a router to get started.</p>
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
            <DialogTitle>{editingRouter ? "Edit Router" : "Add Router"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input {...form.register("name")} placeholder="Core Router 1" />
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
                Save Router
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
