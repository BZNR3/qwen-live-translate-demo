class Pcm16ResamplerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions || {};
    this.targetSampleRate = processorOptions.targetSampleRate || 16000;
    this.chunkSamples = Math.max(
      160,
      Math.round(
        this.targetSampleRate * ((processorOptions.chunkMilliseconds || 100) / 1000),
      ),
    );
    this.ratio = sampleRate / this.targetSampleRate;
    this.inputBuffer = [];
    this.readPosition = 0;
    this.outputBuffer = [];
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data?.type === "stop") this.running = false;
    };
  }

  emitChunk() {
    if (this.outputBuffer.length < this.chunkSamples) return;
    const samples = this.outputBuffer.splice(0, this.chunkSamples);
    const pcm16 = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      pcm16[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
  }

  process(inputs) {
    if (!this.running) return false;
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    for (let index = 0; index < channel.length; index += 1) {
      this.inputBuffer.push(channel[index]);
    }

    while (this.readPosition + 1 < this.inputBuffer.length) {
      const leftIndex = Math.floor(this.readPosition);
      const fraction = this.readPosition - leftIndex;
      const left = this.inputBuffer[leftIndex];
      const right = this.inputBuffer[leftIndex + 1];
      this.outputBuffer.push(left + (right - left) * fraction);
      this.readPosition += this.ratio;
      this.emitChunk();
    }

    const consumed = Math.floor(this.readPosition);
    if (consumed > 0) {
      this.inputBuffer.splice(0, consumed);
      this.readPosition -= consumed;
    }
    return true;
  }
}

registerProcessor("pcm16-resampler", Pcm16ResamplerProcessor);
