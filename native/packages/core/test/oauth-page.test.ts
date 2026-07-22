import { describe, expect, test } from "bun:test"
import { OauthCallbackPage } from "../src/oauth/page"

describe("OauthCallbackPage", () => {
  test("uses ForgeDock branding on every callback state", () => {
    const html = [
      OauthCallbackPage.success({ provider: "ChatGPT" }),
      OauthCallbackPage.error("denied", { provider: "ChatGPT" }),
      OauthCallbackPage.bootstrap({ provider: "ChatGPT", tokenPath: "/token" }),
    ].join("\n")

    expect(html).toContain("FORGEDOCK")
    expect(html).toContain("ForgeDock is now connected to ChatGPT")
    expect(html).toContain("try again from ForgeDock")
    expect(html).not.toContain("OpenCode")
    expect(html).not.toContain("opencode.ai")
  })

  test("escapes bootstrap options embedded in the inline script", () => {
    const html = OauthCallbackPage.bootstrap({
      provider: `xAI</script><script>alert("provider")</script>`,
      tokenPath: `/token</script><script>alert("path")</script>`,
    })

    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain(`xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>`)
    expect(html).toContain(`/token\\u003c/script>\\u003cscript>alert(\\\"path\\\")\\u003c/script>`)
  })
})
