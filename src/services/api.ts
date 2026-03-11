export const getAuthToken = () => sessionStorage.getItem("church_token");

export const apiFetch = async (url: string, options: RequestInit = {}) => {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  if (options.body && typeof options.body === "string") {
    headers["Content-Type"] = "application/json";
  }

  if (options.headers) {
    Object.assign(headers, options.headers);
  }

  console.log(`API Request: ${options.method || "GET"} ${url}`);
  const res = await fetch(url, { ...options, headers });
  console.log(`API Response: ${res.status} ${url}`);
  if (!res.ok) {
    const errorText = await res.text();
    console.error(`API Error (${res.status}): ${errorText}`);
  }
  if (res.status === 401) {
    sessionStorage.removeItem("church_token");
    sessionStorage.removeItem("church_info");
    window.location.reload();
  }
  return res;
};
