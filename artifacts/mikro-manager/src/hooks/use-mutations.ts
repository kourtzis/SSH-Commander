import { useQueryClient } from "@tanstack/react-query";
import { 
  useCreateRouter, useUpdateRouter, useDeleteRouter, getListRoutersQueryKey, getGetRouterQueryKey,
  useCreateGroup, useUpdateGroup, useDeleteGroup, getListGroupsQueryKey, getGetGroupQueryKey, useAddGroupMember, useRemoveGroupMember,
  useCreateSnippet, useUpdateSnippet, useDeleteSnippet, getListSnippetsQueryKey, getGetSnippetQueryKey,
  useCreateJob, useCancelJob, useRerunJob, getListJobsQueryKey, getGetJobQueryKey,
  useCreateUser, useUpdateUser, useDeleteUser, getListUsersQueryKey,
  useCreateSchedule, useUpdateSchedule, useDeleteSchedule, getListSchedulesQueryKey
} from "@workspace/api-client-react";

// Wrappers for generated Orval mutations to add cache invalidation

export function useRoutersMutations() {
  const qc = useQueryClient();
  
  const createRouter = useCreateRouter({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListRoutersQueryKey() }) }
  });
  
  const updateRouter = useUpdateRouter({
    mutation: { 
      onSuccess: (_, vars) => {
        qc.invalidateQueries({ queryKey: getListRoutersQueryKey() });
        qc.invalidateQueries({ queryKey: getGetRouterQueryKey(vars.id) });
      }
    }
  });

  const deleteRouter = useDeleteRouter({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListRoutersQueryKey() }) }
  });

  return { createRouter, updateRouter, deleteRouter };
}

export function useGroupsMutations() {
  const qc = useQueryClient();
  
  const createGroup = useCreateGroup({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListGroupsQueryKey() }) }
  });
  
  const updateGroup = useUpdateGroup({
    mutation: { 
      onSuccess: (_, vars) => {
        qc.invalidateQueries({ queryKey: getListGroupsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetGroupQueryKey(vars.id) });
      }
    }
  });

  const deleteGroup = useDeleteGroup({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListGroupsQueryKey() }) }
  });

  const addMember = useAddGroupMember({
    mutation: { 
      onSuccess: (_, vars) => {
        qc.invalidateQueries({ queryKey: getListGroupsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetGroupQueryKey(vars.id) });
      }
    }
  });

  const removeMember = useRemoveGroupMember({
    mutation: { 
      onSuccess: (_, vars) => {
        qc.invalidateQueries({ queryKey: getListGroupsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetGroupQueryKey(vars.id) });
      }
    }
  });

  return { createGroup, updateGroup, deleteGroup, addMember, removeMember };
}

export function useSnippetsMutations() {
  const qc = useQueryClient();
  
  const createSnippet = useCreateSnippet({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListSnippetsQueryKey() }) }
  });
  
  const updateSnippet = useUpdateSnippet({
    mutation: { 
      onSuccess: (_, vars) => {
        qc.invalidateQueries({ queryKey: getListSnippetsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetSnippetQueryKey(vars.id) });
      }
    }
  });

  const deleteSnippet = useDeleteSnippet({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListSnippetsQueryKey() }) }
  });

  return { createSnippet, updateSnippet, deleteSnippet };
}

export function useJobsMutations() {
  const qc = useQueryClient();
  
  const createJob = useCreateJob({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListJobsQueryKey() }) }
  });
  
  const cancelJob = useCancelJob({
    mutation: { 
      onSuccess: (_, vars) => {
        qc.invalidateQueries({ queryKey: getListJobsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetJobQueryKey(vars.id) });
      }
    }
  });

  const rerunJob = useRerunJob({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getListJobsQueryKey() })
    }
  });

  return { createJob, cancelJob, rerunJob };
}

export function useUsersMutations() {
  const qc = useQueryClient();
  
  const createUser = useCreateUser({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListUsersQueryKey() }) }
  });
  
  const updateUser = useUpdateUser({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListUsersQueryKey() }) }
  });

  const deleteUser = useDeleteUser({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListUsersQueryKey() }) }
  });

  return { createUser, updateUser, deleteUser };
}

export function useSchedulesMutations() {
  const qc = useQueryClient();

  const createSchedule = useCreateSchedule({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListSchedulesQueryKey() }) }
  });

  const updateSchedule = useUpdateSchedule({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListSchedulesQueryKey() }) }
  });

  const deleteSchedule = useDeleteSchedule({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListSchedulesQueryKey() }) }
  });

  return { createSchedule, updateSchedule, deleteSchedule };
}
