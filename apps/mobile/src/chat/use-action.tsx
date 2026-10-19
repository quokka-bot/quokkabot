import { useMutation, useQueryClient } from "@tanstack/react-query";
import { withConsent } from "../consent";
import { useSignedIn } from "../session";

// A send starts only inside withConsent's callback. Declining consent never starts a mutation.
export function useAction<T, V = void>(agentId: string, action: (value: V) => Promise<T>, consent = true) {
  const { connection } = useSignedIn();
  const client = useQueryClient();
  const mutation = useMutation({ mutationFn: action, retry: false,
    onSuccess: () => { void client.invalidateQueries({ queryKey: [connection.origin] }); },
  });
  const run = (value: V) => {
    if (mutation.isPending) return;
    if (consent) withConsent(connection.origin, agentId, () => mutation.mutate(value));
    else mutation.mutate(value);
  };
  return { ...mutation, run };
}
