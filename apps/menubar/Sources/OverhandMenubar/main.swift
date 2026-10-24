// The Overhand menu bar item: the mark and the count of what needs you, and the dashboard's glance page in a popover.
// The daemon starts and watches it (packages/core/src/menubar.ts); every word on it is the page's own (apps/web/src/glance.tsx).
// It never reads the local key: the daemon hands it a signed-in address, and a fresh one when the page asks.
// stdin, one line each: `load <url>`. stdout: `link` (sign the page in again), `open <query>` (the full dashboard in the
// browser), `hide` (switch the item off). It quits when the daemon goes (stdin closes).
import AppKit
import WebKit

/// The popover's width; its height follows the page, between these bounds.
let width = 360.0
let heights = 120.0...560.0

final class Item: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
  let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  let popover = NSPopover()
  let icon: NSImage?
  var web: WKWebView?

  init(icon: NSImage?) {
    self.icon = icon
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    let config = WKWebViewConfiguration()
    config.userContentController.add(self, name: "overhand")
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: heights.lowerBound), configuration: config)
    web.setValue(false, forKey: "drawsBackground") // the popover's own material shows through
    web.navigationDelegate = self
    web.uiDelegate = self
    self.web = web
    let holder = NSViewController()
    holder.view = web
    popover.contentViewController = holder
    popover.contentSize = NSSize(width: width, height: heights.lowerBound)
    popover.behavior = .transient
    if let button = status.button {
      icon?.isTemplate = true // tinted by macOS to suit the bar
      icon?.size = NSSize(width: 18, height: 18)
      button.image = icon
      button.imagePosition = .imageLeading
      button.setAccessibilityLabel("Overhand")
      button.target = self
      button.action = #selector(toggle)
    }
    listen()
  }

  @objc func toggle() {
    guard let button = status.button else { return }
    if popover.isShown {
      popover.performClose(nil)
    } else {
      popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
      NSApp.activate(ignoringOtherApps: true)
    }
  }

  func say(_ line: String) {
    FileHandle.standardOutput.write(Data("\(line)\n".utf8))
  }

  /// Reads the daemon's lines off the main thread; quits once it's gone.
  func listen() {
    DispatchQueue.global().async {
      while let line = readLine() {
        DispatchQueue.main.async { self.handle(line) }
      }
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
  }

  func handle(_ line: String) {
    guard line.hasPrefix("load "), let url = URL(string: String(line.dropFirst(5))) else { return }
    web?.load(URLRequest(url: url))
  }

  /// The count beside the mark: none when nothing needs you, red when something is broken, else amber.
  func show(count: Int, broken: Bool) {
    guard let button = status.button else { return }
    let font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
    let color = broken ? NSColor.systemRed : NSColor.systemOrange
    button.attributedTitle = NSAttributedString(
      string: count > 0 ? " \(count)" : "", attributes: [.font: font, .foregroundColor: color])
    button.setAccessibilityValue(count > 0 ? "\(count)" : "")
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "count":
      show(count: body["n"] as? Int ?? 0, broken: body["broken"] as? Bool ?? false)
    case "height":
      if let h = body["h"] as? Double {
        popover.contentSize = NSSize(width: width, height: min(max(h, heights.lowerBound), heights.upperBound))
      }
    case "signin":
      say("link")
    case "open":
      if let query = body["query"] as? String {
        say("open \(query)")
        popover.performClose(nil)
      }
    case "hide":
      say("hide")
    default:
      break
    }
  }

  /// A link to anywhere but this computer's Overhand opens in the browser.
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    if let url = action.request.url, url.host != "127.0.0.1", ["http", "https"].contains(url.scheme ?? "") {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
    } else {
      decisionHandler(.allow)
    }
  }

  /// A link that asks for a new window opens in the browser too.
  func webView(
    _ webView: WKWebView, createWebViewWith config: WKWebViewConfiguration, for action: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }
}

let args = CommandLine.arguments
let iconPath = args.firstIndex(of: "--icon").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
let item = Item(icon: iconPath.flatMap { NSImage(contentsOfFile: $0) })
let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, no app menu
app.delegate = item
app.run()
