import { createContext, useContext, ReactNode, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe, useLogin, useLogout } from "@workspace/api-client-react";
import type { User, LoginRequest } from "@workspace/api-client-react";
import { getGetMeQueryKey } from "@workspace/api-client-react";

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (data: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  isLoggingIn: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  
  const { data: user, isLoading: isUserLoading } = useGetMe({
    query: {
      retry: false,
      staleTime: Infinity,
    }
  });

  const { mutateAsync: loginMutate, isPending: isLoggingIn } = useLogin();
  const { mutateAsync: logoutMutate } = useLogout();

  const handleLogin = async (data: LoginRequest) => {
    await loginMutate({ data });
    await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
  };

  const handleLogout = async () => {
    await logoutMutate();
    await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
  };

  // We consider it still loading if React Query is fetching it initially
  const isLoading = isUserLoading;

  return (
    <AuthContext.Provider value={{
      user: user || null,
      isLoading,
      login: handleLogin,
      logout: handleLogout,
      isLoggingIn
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
