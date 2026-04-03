class RecordingManager {
  constructor() {
    this.recorder = null;
    this.chunks = [];
    this.isRecording = false;
  }

  startRecording(stream) {
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : "video/webm";

    this.recorder = new MediaRecorder(stream, { mimeType });
    this.chunks = [];

    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };

    this.recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
      a.href = url;
      a.download = `meetspace-recording-${timestamp}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.chunks = [];
    };

    this.recorder.start(100); // Collect  chunks every 100ms
    this.isRecording = true;
  }

  stopRecording() {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
      this.isRecording = false;
    }
  }

  getState() {
    return this.isRecording;
  }
}
