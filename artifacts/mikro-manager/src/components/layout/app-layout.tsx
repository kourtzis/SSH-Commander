import { ReactNode } from "react";
import { AppSidebar } from "./sidebar";
import { motion } from "framer-motion";

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background text-foreground selection:bg-primary/30">
      <AppSidebar />
      <main className="flex-1 ml-64 min-h-screen overflow-x-hidden">
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="max-w-7xl mx-auto p-8"
        >
          {children}
        </motion.div>
      </main>
    </div>
  );
}
