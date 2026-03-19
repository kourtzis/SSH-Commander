import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useListRouters, useListGroups, useListSnippets } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { useJobsMutations } from "@/hooks/use-mutations";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Play, Upload, Code, Target, Table as TableIcon, Monitor } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { extractTags } from "@/lib/utils";
import * as XLSX from "xlsx";

function useResolvedDeviceCount(routerIds: number[], groupIds: number[]) {
  return useQuery({
    queryKey: ["resolve-count", routerIds, groupIds],
    queryFn: async () => {
      if (routerIds.length === 0 && groupIds.length === 0) return 0;
      const res = await fetch(`${import.meta.env.BASE_URL}api/jobs/resolve-count`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ targetRouterIds: routerIds, targetGroupIds: groupIds }),
      });
      if (!res.ok) return 0;
      const data = await res.json();
      return data.count as number;
    },
    enabled: routerIds.length > 0 || groupIds.length > 0,
  });
}

export default function NewJob() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { createJob } = useJobsMutations();

  const { data: routers = [] } = useListRouters();
  const { data: groups = [] } = useListGroups();
  const { data: snippets = [] } = useListSnippets();

  const [name, setName] = useState("");
  const [scriptCode, setScriptCode] = useState("");
  const [selectedRouters, setSelectedRouters] = useState<Set<number>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<number>>(new Set());
  const [excelData, setExcelData] = useState<any[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: resolvedCount = 0, isFetching: isResolvingCount } = useResolvedDeviceCount(
    Array.from(selectedRouters),
    Array.from(selectedGroups)
  );

  const tags = extractTags(scriptCode);

  const handleSnippetSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const snippet = snippets.find(s => s.id === parseInt(e.target.value));
    if (snippet) {
      setScriptCode(snippet.code);
      if (!name) setName(`Job: ${snippet.name}`);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: "binary" });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json(ws);
        
        // Convert all keys and values to strings for API compatibility
        const formattedData = data.map((row: any) => {
          const newRow: any = {};
          Object.keys(row).forEach(k => {
            newRow[k] = String(row[k]);
          });
          return newRow;
        });

        setExcelData(formattedData);
        toast({ title: "Data loaded", description: `Loaded ${formattedData.length} rows from file.` });
      } catch (err) {
        toast({ title: "Error parsing file", variant: "destructive" });
      }
    };
    reader.readAsBinaryString(file);
  };

  const toggleRouter = (id: number) => {
    const next = new Set(selectedRouters);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedRouters(next);
  };

  const toggleGroup = (id: number) => {
    const next = new Set(selectedGroups);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedGroups(next);
  };

  const handleSubmit = async () => {
    if (!name || !scriptCode || (selectedRouters.size === 0 && selectedGroups.size === 0)) {
      toast({ title: "Missing fields", description: "Please fill in all required fields.", variant: "destructive" });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await createJob.mutateAsync({
        data: {
          name,
          scriptCode,
          targetRouterIds: Array.from(selectedRouters),
          targetGroupIds: Array.from(selectedGroups),
          excelData: excelData.length > 0 ? excelData : undefined
        }
      });
      toast({ title: "Job started successfully!" });
      setLocation(`/jobs/${res.id}`);
    } catch (e: any) {
      toast({ title: "Failed to start job", description: e.message, variant: "destructive" });
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-20">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Create Batch Job</h1>
        <p className="text-muted-foreground mt-1">Configure and launch a script across multiple devices.</p>
      </div>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Code className="w-5 h-5 text-primary" /> 1. Script Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Job Name *</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Firmware Update Q3" />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between items-end">
              <Label>Load from Snippet (Optional)</Label>
            </div>
            <select 
              className="flex h-10 w-full rounded-xl border border-input bg-background/50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              onChange={handleSnippetSelect}
              defaultValue=""
            >
              <option value="" disabled>Select a saved snippet...</option>
              {snippets.map(s => <option key={s.id} value={s.id}>{s.name} ({s.category})</option>)}
            </select>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <Label>Script Code *</Label>
              {tags.length > 0 && (
                <div className="flex gap-2 items-center">
                  <span className="text-xs text-muted-foreground">Variables detected:</span>
                  {tags.map(t => <Badge key={t} variant="outline" className="text-primary border-primary/30 text-xs px-1.5 py-0">{(t)}</Badge>)}
                </div>
              )}
            </div>
            <Textarea 
              value={scriptCode} 
              onChange={e => setScriptCode(e.target.value)} 
              className="h-64 font-mono"
              placeholder="/system identity set name={{HOSTNAME}}"
            />
          </div>
        </CardContent>
      </Card>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Target className="w-5 h-5 text-primary" /> 2. Target Selection *
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-3">
              <Label className="text-base">Routers</Label>
              <div className="h-48 overflow-y-auto border border-white/5 rounded-xl p-2 bg-black/20 space-y-1">
                {routers.map(r => (
                  <label key={r.id} className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-lg cursor-pointer">
                    <input 
                      type="checkbox" 
                      className="w-4 h-4 rounded border-white/20 bg-black/50 text-primary accent-primary" 
                      checked={selectedRouters.has(r.id)}
                      onChange={() => toggleRouter(r.id)}
                    />
                    <span className="text-sm font-medium">{r.name} <span className="text-muted-foreground font-mono text-xs ml-1">({r.ipAddress})</span></span>
                  </label>
                ))}
              </div>
            </div>
            
            <div className="space-y-3">
              <Label className="text-base">Router Groups</Label>
              <div className="h-48 overflow-y-auto border border-white/5 rounded-xl p-2 bg-black/20 space-y-1">
                {groups.map(g => (
                  <label key={g.id} className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-lg cursor-pointer">
                    <input 
                      type="checkbox" 
                      className="w-4 h-4 rounded border-white/20 bg-black/50 text-primary accent-primary" 
                      checked={selectedGroups.has(g.id)}
                      onChange={() => toggleGroup(g.id)}
                    />
                    <span className="text-sm font-medium">{g.name}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {(selectedRouters.size > 0 || selectedGroups.size > 0) && (
            <div className="mt-4 flex items-center gap-3 p-4 rounded-xl bg-primary/10 border border-primary/20">
              <Monitor className="w-5 h-5 text-primary shrink-0" />
              <div>
                <span className="text-sm font-semibold text-primary">
                  {isResolvingCount ? "Resolving..." : `${resolvedCount} device${resolvedCount !== 1 ? "s" : ""}`}
                </span>
                <span className="text-sm text-muted-foreground ml-1">will be targeted (after deduplication)</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <TableIcon className="w-5 h-5 text-primary" /> 3. Data Substitution (Optional)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground mb-4">
            Upload an Excel or CSV file to replace variables in your script. 
            The file should have column headers matching your tags (e.g. <span className="font-mono text-primary">HOSTNAME</span>).
          </p>
          
          <div className="border-2 border-dashed border-white/10 rounded-xl p-8 text-center bg-black/20 hover:bg-white/5 transition-colors relative">
            <input 
              type="file" 
              accept=".csv,.xlsx,.xls" 
              onChange={handleFileUpload} 
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <Upload className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="font-medium">Click or drag file to upload</p>
            <p className="text-xs text-muted-foreground mt-1">Supports .csv, .xlsx</p>
          </div>

          {excelData.length > 0 && (
            <div className="mt-4">
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-medium text-emerald-400">Data Loaded ({excelData.length} rows)</span>
                <Button variant="ghost" size="sm" onClick={() => setExcelData([])} className="h-8 text-destructive">Clear Data</Button>
              </div>
              <div className="overflow-x-auto rounded-xl border border-white/5">
                <table className="w-full text-xs text-left">
                  <thead className="bg-black/40 text-muted-foreground">
                    <tr>
                      {Object.keys(excelData[0]).map(k => <th key={k} className="px-4 py-2 font-mono">{k}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {excelData.slice(0, 3).map((row, i) => (
                      <tr key={i} className="bg-background/50">
                        {Object.values(row).map((v: any, j) => <td key={j} className="px-4 py-2">{v}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {excelData.length > 3 && <div className="p-2 text-center text-xs text-muted-foreground bg-black/20">...and {excelData.length - 3} more rows</div>}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end pt-4">
        <Button size="lg" onClick={handleSubmit} disabled={isSubmitting} className="w-full sm:w-auto text-lg gap-2 shadow-[0_0_20px_rgba(45,212,191,0.3)]">
          {isSubmitting ? "Starting..." : <><Play className="w-5 h-5 fill-current" /> Execute Batch Job</>}
        </Button>
      </div>
    </div>
  );
}
