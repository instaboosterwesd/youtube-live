type FirebaseRequestInit = {
  method?: "GET" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
};

function databaseUrl(): string {
  const value = process.env.FIREBASE_DATABASE_URL?.trim();
  if (!value) throw new Error("FIREBASE_DATABASE_URL is not configured.");
  return value.replace(/\/+$/, "");
}

export async function firebaseRequest<T>(path: string, init: FirebaseRequestInit = {}): Promise<T> {
  const response = await fetch(`${databaseUrl()}/${path.replace(/^\/+/, "")}.json`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `Firebase request failed with status ${response.status}.`;
    throw new Error(message);
  }
  return payload as T;
}

export const firebaseGet = <T>(path: string) => firebaseRequest<T>(path);
export const firebasePut = <T>(path: string, body: unknown) => firebaseRequest<T>(path, { method: "PUT", body });
export const firebaseDelete = <T>(path: string) => firebaseRequest<T>(path, { method: "DELETE" });
