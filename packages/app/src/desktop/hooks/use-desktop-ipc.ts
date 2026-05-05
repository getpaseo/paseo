import { useEffect, useRef } from "react";
import {
  useMutation,
  useQuery,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";

interface DesktopIpcErrorOptions {
  errorMessage: string;
  logLabel: string;
}

interface UseDesktopMutationOptions<TData, TVariables, TOnMutateResult>
  extends
    DesktopIpcErrorOptions,
    Omit<UseMutationOptions<TData, Error, TVariables, TOnMutateResult>, "mutationFn" | "onError"> {
  mutationFn: (variables: TVariables) => Promise<TData>;
  onError?: UseMutationOptions<TData, Error, TVariables, TOnMutateResult>["onError"];
}

interface UseDesktopQueryOptions<TData, TQueryKey extends QueryKey>
  extends DesktopIpcErrorOptions, Omit<UseQueryOptions<TData, Error, TData, TQueryKey>, "queryFn"> {
  queryFn: () => Promise<TData>;
}

export function useDesktopMutation<TData, TVariables = void, TOnMutateResult = unknown>(
  options: UseDesktopMutationOptions<TData, TVariables, TOnMutateResult>,
): UseMutationResult<TData, Error, TVariables, TOnMutateResult> {
  const toast = useToast();
  const { errorMessage, logLabel, mutationFn, onError, ...mutationOptions } = options;

  return useMutation<TData, Error, TVariables, TOnMutateResult>({
    ...mutationOptions,
    mutationFn,
    onError: async (error, variables, onMutateResult, context) => {
      console.error(logLabel, error);
      toast.error(errorMessage);
      await onError?.(error, variables, onMutateResult, context);
    },
  });
}

export function useDesktopQuery<TData, TQueryKey extends QueryKey>(
  options: UseDesktopQueryOptions<TData, TQueryKey>,
): UseQueryResult<TData, Error> {
  const toast = useToast();
  const lastToastedErrorRef = useRef<Error | null>(null);
  const { errorMessage, logLabel, queryFn, retry, ...queryOptions } = options;
  const query = useQuery<TData, Error, TData, TQueryKey>({
    ...queryOptions,
    queryFn,
    retry: retry ?? false,
  });

  useEffect(() => {
    if (!query.error || query.error === lastToastedErrorRef.current) {
      return;
    }

    lastToastedErrorRef.current = query.error;
    console.error(logLabel, query.error);
    toast.error(errorMessage);
  }, [errorMessage, logLabel, query.error, toast]);

  return query;
}
