// Loaded by the service worker. Static hosts such as GitHub Pages send the iPhone profile as
// a generic download; iOS only offers to install it when it arrives with Apple's own type.
self.addEventListener("fetch", (event) => {
  if (!new URL(event.request.url).pathname.endsWith(".mobileconfig")) return;
  event.respondWith(
    fetch(event.request.url, { cache: "no-store" }).then(
      async (res) =>
        new Response(await res.blob(), {
          status: res.status,
          headers: { "Content-Type": "application/x-apple-aspen-config" },
        }),
    ),
  );
});
