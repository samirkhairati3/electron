import { webContents } from 'electron/main';
import { ipcMainInternal } from '@electron/internal/browser/ipc-main-internal';
import * as ipcMainUtils from '@electron/internal/browser/ipc-main-internal-utils';
import { parseWebViewWebPreferences } from '@electron/internal/common/parse-features-string';
import { syncMethods, asyncMethods, properties } from '@electron/internal/common/web-view-methods';
import { webViewEvents } from '@electron/internal/common/web-view-events';
import { serialize } from '@electron/internal/common/type-utils';
import { IPC_MESSAGES } from '@electron/internal/common/ipc-messages';

interface GuestInstance {
  elementInstanceId?: number;
  visibilityState?: VisibilityState;
  embedder: Electron.WebContents;
  guest: Electron.WebContents;
}

const webViewManager = process._linkedBinding('electron_browser_web_view_manager');

const supportedWebViewEvents = Object.keys(webViewEvents);

const guestInstances: Record<string, GuestInstance> = {};
const embedderElementsMap: Record<string, number> = {};

function sanitizeOptionsForGuest (options: Record<string, any>) {
  const ret = { ...options };
  // WebContents values can't be sent over IPC.
  delete ret.webContents;
  return ret;
}

// Create a new guest instance.
const createGuest = function (event: Electron.IpcMainInvokeEvent,
  embedderFrameId: number, elementInstanceId: number, params: Record<string, any>) {
  const embedder = event.sender;
  // eslint-disable-next-line no-undef
  const guest = (webContents as typeof ElectronInternal.WebContents).create({
    type: 'webview',
    partition: params.partition,
    embedder: embedder
  });
  const guestInstanceId = guest.id;
  guestInstances[guestInstanceId] = {
    guest: guest,
    embedder: embedder
  };

  // Clear the guest from map when it is destroyed.
  guest.once('destroyed', () => {
    if (Object.prototype.hasOwnProperty.call(guestInstances, guestInstanceId)) {
      detachGuest(embedder, guestInstanceId);
    }
  });

  // Init guest web view after attached.
  guest.once('did-attach' as any, function (this: Electron.WebContents, event: Electron.Event) {
    params = this.attachParams!;
    delete this.attachParams;

    const previouslyAttached = this.viewInstanceId != null;
    this.viewInstanceId = params.instanceId;

    // Only load URL and set size on first attach
    if (previouslyAttached) {
      return;
    }

    if (params.src) {
      const opts: Electron.LoadURLOptions = {};
      if (params.httpreferrer) {
        opts.httpReferrer = params.httpreferrer;
      }
      if (params.useragent) {
        opts.userAgent = params.useragent;
      }
      this.loadURL(params.src, opts);
    }
    embedder.emit('did-attach-webview', event, guest);
  });

  const sendToEmbedder = (channel: string, ...args: any[]) => {
    if (!embedder.isDestroyed()) {
      embedder._sendInternal(`${channel}-${guest.viewInstanceId}`, ...args);
    }
  };

  // Dispatch events to embedder.
  const fn = function (event: string) {
    guest.on(event as any, function (_, ...args: any[]) {
      sendToEmbedder(IPC_MESSAGES.GUEST_VIEW_INTERNAL_DISPATCH_EVENT, event, ...args);
    });
  };
  for (const event of supportedWebViewEvents) {
    if (event !== 'new-window') {
      fn(event);
    }
  }

  guest.on('new-window', function (event, url, frameName, disposition, options, additionalFeatures, referrer) {
    sendToEmbedder(IPC_MESSAGES.GUEST_VIEW_INTERNAL_DISPATCH_EVENT, 'new-window', url,
      frameName, disposition, sanitizeOptionsForGuest(options),
      additionalFeatures, referrer);
  });

  // Dispatch guest's IPC messages to embedder.
  guest.on('ipc-message-host' as any, function (_: Electron.Event, channel: string, args: any[]) {
    sendToEmbedder(IPC_MESSAGES.GUEST_VIEW_INTERNAL_IPC_MESSAGE, channel, ...args);
  });

  // Notify guest of embedder window visibility when it is ready
  // FIXME Remove once https://github.com/electron/electron/issues/6828 is fixed
  guest.on('dom-ready', function () {
    const guestInstance = guestInstances[guestInstanceId];
    if (guestInstance != null && guestInstance.visibilityState != null) {
      guest._sendInternal(IPC_MESSAGES.GUEST_INSTANCE_VISIBILITY_CHANGE, guestInstance.visibilityState);
    }
  });

  if (attachGuest(event, embedderFrameId, elementInstanceId, guestInstanceId, params)) {
    return guestInstanceId;
  }

  return -1;
};

// Attach the guest to an element of embedder.
const attachGuest = function (event: Electron.IpcMainInvokeEvent,
  embedderFrameId: number, elementInstanceId: number, guestInstanceId: number, params: Record<string, any>) {
  const embedder = event.sender;
  // Destroy the old guest when attaching.
  const key = `${embedder.id}-${elementInstanceId}`;
  const oldGuestInstanceId = embedderElementsMap[key];
  if (oldGuestInstanceId != null) {
    // Reattachment to the same guest is just a no-op.
    if (oldGuestInstanceId === guestInstanceId) {
      return false;
    }

    const oldGuestInstance = guestInstances[oldGuestInstanceId];
    if (oldGuestInstance) {
      oldGuestInstance.guest.detachFromOuterFrame();
    }
  }

  const guestInstance = guestInstances[guestInstanceId];
  // If this isn't a valid guest instance then do nothing.
  if (!guestInstance) {
    console.error(new Error(`Guest attach failed: Invalid guestInstanceId ${guestInstanceId}`));
    return false;
  }
  const { guest } = guestInstance;
  if (guest.hostWebContents !== embedder) {
    console.error(new Error(`Guest attach failed: Access denied to guestInstanceId ${guestInstanceId}`));
    return false;
  }

  // If this guest is already attached to an element then remove it
  if (guestInstance.elementInstanceId) {
    const oldKey = `${guestInstance.embedder.id}-${guestInstance.elementInstanceId}`;
    delete embedderElementsMap[oldKey];

    // Remove guest from embedder if moving across web views
    if (guest.viewInstanceId !== params.instanceId) {
      webViewManager.removeGuest(guestInstance.embedder, guestInstanceId);
      guestInstance.embedder._sendInternal(`${IPC_MESSAGES.GUEST_VIEW_INTERNAL_DESTROY_GUEST}-${guest.viewInstanceId}`);
    }
  }

  // parse the 'webpreferences' attribute string, if set
  // this uses the same parsing rules as window.open uses for its features
  const parsedWebPreferences =
    typeof params.webpreferences === 'string'
      ? parseWebViewWebPreferences(params.webpreferences)
      : null;

  const webPreferences: Electron.WebPreferences = {
    guestInstanceId: guestInstanceId,
    nodeIntegration: params.nodeintegration != null ? params.nodeintegration : false,
    nodeIntegrationInSubFrames: params.nodeintegrationinsubframes != null ? params.nodeintegrationinsubframes : false,
    enableRemoteModule: params.enableremotemodule,
    plugins: params.plugins,
    zoomFactor: embedder.zoomFactor,
    disablePopups: !params.allowpopups,
    webSecurity: !params.disablewebsecurity,
    enableBlinkFeatures: params.blinkfeatures,
    disableBlinkFeatures: params.disableblinkfeatures,
    ...parsedWebPreferences
  };

  if (params.preload) {
    webPreferences.preloadURL = params.preload;
  }

  // Security options that guest will always inherit from embedder
  const inheritedWebPreferences = new Map([
    ['contextIsolation', true],
    ['javascript', false],
    ['nativeWindowOpen', true],
    ['nodeIntegration', false],
    ['enableRemoteModule', false],
    ['sandbox', true],
    ['nodeIntegrationInSubFrames', false],
    ['enableWebSQL', false]
  ]);

  // Inherit certain option values from embedder
  const lastWebPreferences = embedder.getLastWebPreferences();
  for (const [name, value] of inheritedWebPreferences) {
    if ((lastWebPreferences as any)[name] === value) {
      (webPreferences as any)[name] = value;
    }
  }

  embedder.emit('will-attach-webview', event, webPreferences, params);
  if (event.defaultPrevented) {
    if (guest.viewInstanceId == null) guest.viewInstanceId = params.instanceId;
    guest.destroy();
    return false;
  }

  guest.attachParams = params;
  embedderElementsMap[key] = guestInstanceId;

  guest.setEmbedder(embedder);
  guestInstance.embedder = embedder;
  guestInstance.elementInstanceId = elementInstanceId;

  watchEmbedder(embedder);

  webViewManager.addGuest(guestInstanceId, elementInstanceId, embedder, guest, webPreferences);
  guest.attachToIframe(embedder, embedderFrameId);
  return true;
};

// Remove an guest-embedder relationship.
const detachGuest = function (embedder: Electron.WebContents, guestInstanceId: number) {
  const guestInstance = guestInstances[guestInstanceId];

  if (!guestInstance) return;

  if (embedder !== guestInstance.embedder) {
    return;
  }

  webViewManager.removeGuest(embedder, guestInstanceId);
  delete guestInstances[guestInstanceId];

  const key = `${embedder.id}-${guestInstance.elementInstanceId}`;
  delete embedderElementsMap[key];
};

// Once an embedder has had a guest attached we watch it for destruction to
// destroy any remaining guests.
const watchedEmbedders = new Set<Electron.WebContents>();
const watchEmbedder = function (embedder: Electron.WebContents) {
  if (watchedEmbedders.has(embedder)) {
    return;
  }
  watchedEmbedders.add(embedder);

  // Forward embedder window visibility change events to guest
  const onVisibilityChange = function (visibilityState: VisibilityState) {
    for (const guestInstanceId of Object.keys(guestInstances)) {
      const guestInstance = guestInstances[guestInstanceId];
      guestInstance.visibilityState = visibilityState;
      if (guestInstance.embedder === embedder) {
        guestInstance.guest._sendInternal(IPC_MESSAGES.GUEST_INSTANCE_VISIBILITY_CHANGE, visibilityState);
      }
    }
  };
  embedder.on('-window-visibility-change' as any, onVisibilityChange);

  embedder.once('will-destroy' as any, () => {
    // Usually the guestInstances is cleared when guest is destroyed, but it
    // may happen that the embedder gets manually destroyed earlier than guest,
    // and the embedder will be invalid in the usual code path.
    for (const guestInstanceId of Object.keys(guestInstances)) {
      const guestInstance = guestInstances[guestInstanceId];
      if (guestInstance.embedder === embedder) {
        detachGuest(embedder, parseInt(guestInstanceId));
      }
    }
    // Clear the listeners.
    embedder.removeListener('-window-visibility-change' as any, onVisibilityChange);
    watchedEmbedders.delete(embedder);
  });
};

const isWebViewTagEnabledCache = new WeakMap();

export const isWebViewTagEnabled = function (contents: Electron.WebContents) {
  if (!isWebViewTagEnabledCache.has(contents)) {
    const webPreferences = contents.getLastWebPreferences() || {};
    isWebViewTagEnabledCache.set(contents, !!webPreferences.webviewTag);
  }

  return isWebViewTagEnabledCache.get(contents);
};

const makeSafeHandler = function<Event extends { sender: Electron.WebContents }> (channel: string, handler: (event: Event, ...args: any[]) => any) {
  return (event: Event, ...args: any[]) => {
    if (isWebViewTagEnabled(event.sender)) {
      return handler(event, ...args);
    } else {
      console.error(`<webview> IPC message ${channel} sent by WebContents with <webview> disabled (${event.sender.id})`);
      throw new Error('<webview> disabled');
    }
  };
};

const handleMessage = function (channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any) {
  ipcMainInternal.handle(channel, makeSafeHandler(channel, handler));
};

const handleMessageSync = function (channel: string, handler: (event: ElectronInternal.IpcMainInternalEvent, ...args: any[]) => any) {
  ipcMainUtils.handleSync(channel, makeSafeHandler(channel, handler));
};

handleMessage(IPC_MESSAGES.GUEST_VIEW_MANAGER_CREATE_AND_ATTACH_GUEST, function (event, embedderFrameId: number, elementInstanceId: number, params) {
  return createGuest(event, embedderFrameId, elementInstanceId, params);
});

handleMessageSync(IPC_MESSAGES.GUEST_VIEW_MANAGER_DETACH_GUEST, function (event, guestInstanceId: number) {
  return detachGuest(event.sender, guestInstanceId);
});

// this message is sent by the actual <webview>
ipcMainInternal.on(IPC_MESSAGES.GUEST_VIEW_MANAGER_FOCUS_CHANGE, function (event: ElectronInternal.IpcMainInternalEvent, focus: boolean, guestInstanceId: number) {
  const guest = getGuest(guestInstanceId);
  if (guest === event.sender) {
    event.sender.emit('focus-change', {}, focus, guestInstanceId);
  } else {
    console.error(`focus-change for guestInstanceId: ${guestInstanceId}`);
  }
});

handleMessage(IPC_MESSAGES.GUEST_VIEW_MANAGER_CALL, function (event, guestInstanceId: number, method: string, args: any[]) {
  const guest = getGuestForWebContents(guestInstanceId, event.sender);
  if (!asyncMethods.has(method)) {
    throw new Error(`Invalid method: ${method}`);
  }

  return (guest as any)[method](...args);
});

handleMessageSync(IPC_MESSAGES.GUEST_VIEW_MANAGER_CALL, function (event, guestInstanceId: number, method: string, args: any[]) {
  const guest = getGuestForWebContents(guestInstanceId, event.sender);
  if (!syncMethods.has(method)) {
    throw new Error(`Invalid method: ${method}`);
  }

  return (guest as any)[method](...args);
});

handleMessageSync(IPC_MESSAGES.GUEST_VIEW_MANAGER_PROPERTY_GET, function (event, guestInstanceId: number, property: string) {
  const guest = getGuestForWebContents(guestInstanceId, event.sender);
  if (!properties.has(property)) {
    throw new Error(`Invalid property: ${property}`);
  }

  return (guest as any)[property];
});

handleMessageSync(IPC_MESSAGES.GUEST_VIEW_MANAGER_PROPERTY_SET, function (event, guestInstanceId: number, property: string, val: any) {
  const guest = getGuestForWebContents(guestInstanceId, event.sender);
  if (!properties.has(property)) {
    throw new Error(`Invalid property: ${property}`);
  }

  (guest as any)[property] = val;
});

handleMessage(IPC_MESSAGES.GUEST_VIEW_MANAGER_CAPTURE_PAGE, async function (event, guestInstanceId: number, args: any[]) {
  const guest = getGuestForWebContents(guestInstanceId, event.sender);

  return serialize(await guest.capturePage(...args));
});

// Returns WebContents from its guest id hosted in given webContents.
const getGuestForWebContents = function (guestInstanceId: number, contents: Electron.WebContents) {
  const guest = getGuest(guestInstanceId);
  if (!guest) {
    throw new Error(`Invalid guestInstanceId: ${guestInstanceId}`);
  }
  if (guest.hostWebContents !== contents) {
    throw new Error(`Access denied to guestInstanceId: ${guestInstanceId}`);
  }
  return guest;
};

// Returns WebContents from its guest id.
const getGuest = function (guestInstanceId: number) {
  const guestInstance = guestInstances[guestInstanceId];
  if (guestInstance != null) return guestInstance.guest;
};
