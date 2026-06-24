export class WebSocketClient {
  private url: string;
  private ws: WebSocket | null = null;
  private onMessageCallback: (data: any) => void;
  private onStatusChangeCallback: (status: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING') => void;
  
  private reconnectAttempts = 0;
  private maxReconnectDelay = 10000;
  private isReconnectExpected = false;

  constructor(
    onMessage: (data: any) => void,
    onStatusChange: (status: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING') => void
  ) {
    this.onMessageCallback = onMessage;
    this.onStatusChangeCallback = onStatusChange;
    
    // Auto-detect secure/insecure WebSocket protocols based on window location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // If running in development proxy, point to ws://localhost:8888/ws/updates, otherwise use current hostname
    const host = window.location.host === 'localhost:5173' ? 'localhost:8888' : window.location.host;
    this.url = `${protocol}//${host}/ws/updates`;
  }

  public connect() {
    this.isReconnectExpected = true;
    try {
      this.ws = new WebSocket(this.url);
      
      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.onStatusChangeCallback('CONNECTED');
      };

      this.ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          this.onMessageCallback(payload);
        } catch (e) {
          console.error("Failed to parse WebSocket message:", e);
        }
      };

      this.ws.onclose = () => {
        this.onStatusChangeCallback('DISCONNECTED');
        if (this.isReconnectExpected) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err) => {
        console.error("WebSocket error:", err);
      };
    } catch (e) {
      console.error("WebSocket connection failure:", e);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    this.onStatusChangeCallback('RECONNECTING');
    
    // Backoff delay calculation
    const delay = Math.min(
      1000 * Math.pow(1.5, this.reconnectAttempts++),
      this.maxReconnectDelay
    );

    setTimeout(() => {
      if (this.isReconnectExpected) {
        console.log(`Attempting WebSocket reconnection (Attempt ${this.reconnectAttempts})...`);
        this.connect();
      }
    }, delay);
  }

  public disconnect() {
    this.isReconnectExpected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
