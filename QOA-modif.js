/* 
    QOA audio codec written by Dominic Szablewski: https://github.com/phoboslab
    Modified by MINT: https://www.youtube.com/@__MINT_
    
    What MINT added?
    - bits per sample can be in range [1-4], no longer fixed at 3
    - everything was fine-tuned (and it turnes out that values of most parameters were already close to optimal)
    
    What MINT removed?
    - some overhead data from frames
    - compatibility with original QOA xDDDD
    
    Result is very similar to SEA codec: https://github.com/Daninet/sea-codec
    But mine was written earlier! Although published later...
    
    Don't expect much from this code, it just works. There are mixed QOA / FAC name prefixes
    cause I wasn't even sure whether it will be my own FAC codec based on QOA or just fancier version of QOA.
    It even has 'fac_' file header. In the end, FAC was created from scratch and this FAC/QOA codec remained.
    So why not publish it?
    
    Usage:
    QOA runs in JavaScript, so just a browser is needed. There are two main functions, for encoding and decoding:
    - qoa_encode({channelData, sampleRate, bitsPerSample})
        Arguments (input object members):
            - channelData: array of arrays holding audio samples for each channel. For example [[audio_L], [audio_R]].
                Up to 255 channels supported, 16-bit signed PCM format is expected.
            - sampleRate: audio sample rate, 24-bit value (more than enough range), defaults to 44.1 kHz if not given.
            - bitsPerSample: bits per audio sample, must be in range [1-4]. Defaults to 3 if not given.
        Returns:
            - Uint8Array (so just an array of bytes) representing encoded audio.
            
    - qoa_decode(data)
        Arguments:
            - data: Uint8Array (so just an array of bytes) representing encoded audio.
        Returns:
            - object with decoded audio, object members:
                - channels: number of audio channels
                - samples: number of samples per channel
                - sampleRate: audio sample rate
                - bitsPerSample: bits per audio sample used in encoded audio
                - channelData: array of arrays holding audio samples for each channel, for example [[audio_L], [audio_R]]. 16-bit signed PCM format.


    Note: 3-bit mode uses identical tables as in the original QOA.
    
    This software is provided "as-is" and comes with absolutely no warranty!
*/

const FAC_SLICE_LEN = 20;
const FAC_SLICES_PER_FRAME = 256;
const FAC_FRAME_LEN = FAC_SLICES_PER_FRAME * FAC_SLICE_LEN;
const FAC_LMS_LEN = 4; // default size: 4; Slightly better quality with larger ones
const FAC_PRED_SHIFT = 13; // optimal value, confirmed by tests with sizes 4 - 24
const FAC_UPD_SHIFT = 4; // optimal values for each size: 4-9: 4, 10-22: 5, 23-24: 6
const FAC_MAGIC = 0x6661635f; /* 'fac_' */
const FAC_FRAME_MARK = 0x46; // F
const FAC_LMS_LEN_M1 = FAC_LMS_LEN - 1;

const fac_scalefactor_tab = [1, 7, 21, 45, 84, 138, 211, 304, 421, 562, 731, 928, 1157, 1419, 1715, 2048]; 
/*
	Table holding scalefactors by which raw residuals (differences between predicted sample
	and real sample) will be divided to quantize them. This table is actually not used,
	but based on it, reciprocal_tab below was constructed.
*/

const fac_reciprocal_tab = [65536, 9363, 3121, 1457, 781, 475, 311, 216, 156, 117, 90, 71, 57, 47, 39, 32];
/*
	Table holding inverse scalefactors which are used to quantize residual values.
	Having scalefactors inversed here, we can use multiplication instead of slow
	division. Values are actually not 1/scalefactor, but rounded 65536/scalefactor.
*/

const fac_quant_tab = [ // Mapping of quantized residual values, from -8 to 8
  [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], 		// 1-bit
  [3, 3, 3, 3, 3, 1, 1, 1, 0, 0, 0, 0, 2, 2, 2, 2, 2],		// 2-bit
  [7, 7, 7, 5, 5, 3, 3, 1, 0, 0, 2, 2, 4, 4, 6, 6, 6],		// 3-bit
  [15, 13, 11, 9, 7, 5, 3, 1, 0, 0, 2, 4, 6, 8, 10, 12, 14]	// 4-bit
];
/*
	Example: in 2-bit mode, values from -8 to -5 are mapped to 3,
	values from -4 to -1 are mapped to 1, values from 0 to 4 are mapped to 0, etc.
*/

const fac_dequant_tab = [
[[5, -5], [32, -32], [95, -95], [203, -203], [378, -378], [621, -621], [950, -950],
[1368, -1368], [1895, -1895], [2529, -2529], [3290, -3290], [4176, -4176], [5207, -5207],
[6386, -6386], [7718, -7718], [9216, -9216]],

[[3, -3, 7, -7], [18, -18, 46, -46], [53, -53, 137, -137], [113, -113, 293, -293],
[210, -210, 546, -546], [345, -345, 897, -897], [528, -528, 1372, -1372], 
[760, -760, 1976, -1976], [1053, -1053, 2737, -2737], [1405, -1405, 3653, -3653],
[1828, -1828, 4752, -4752], [2320, -2320, 6032, -6032], [2893, -2893, 7521, -7521],
[3548, -3548, 9224, -9224], [4288, -4288, 11148, -11148], [5120, -5120, 13312, -13312]],

[[1, -1, 3, -3, 5, -5, 7, -7], [5, -5, 18, -18, 32, -32, 49, -49],
[16, -16, 53, -53, 95, -95, 147, -147], [34, -34, 113, -113, 203, -203, 315, -315],
[63, -63, 210, -210, 378, -378, 588, -588], [104, -104, 345, -345, 621, -621, 966, -966],
[158, -158, 528, -528, 950, -950, 1477, -1477], [228, -228, 760, -760, 1368, -1368, 2128, -2128],
[316, -316, 1053, -1053, 1895, -1895, 2947, -2947], [422, -422, 1405, -1405, 2529, -2529, 3934, -3934],
[548, -548, 1828, -1828, 3290, -3290, 5117, -5117], [696, -696, 2320, -2320, 4176, -4176, 6496, -6496],
[868, -868, 2893, -2893, 5207, -5207, 8099, -8099], [1064, -1064, 3548, -3548, 6386, -6386, 9933, -9933],
[1286, -1286, 4288, -4288, 7718, -7718, 12005, -12005], [1536, -1536, 5120, -5120, 9216, -9216, 14336, -14336]],

[[1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8],
[7, -7, 14, -14, 21, -21, 28, -28, 35, -35, 42, -42, 49, -49, 56, -56],
[21, -21, 42, -42, 63, -63, 84, -84, 105, -105, 126, -126, 147, -147, 168, -168],
[45, -45, 90, -90, 135, -135, 180, -180, 225, -225, 270, -270, 315, -315, 360, -360],
[84, -84, 168, -168, 252, -252, 336, -336, 420, -420, 504, -504, 588, -588, 672, -672],
[138, -138, 276, -276, 414, -414, 552, -552, 690, -690, 828, -828, 966, -966, 1104, -1104],
[211, -211, 422, -422, 633, -633, 844, -844, 1055, -1055, 1266, -1266, 1477, -1477, 1688, -1688],
[304, -304, 608, -608, 912, -912, 1216, -1216, 1520, -1520, 1824, -1824, 2128, -2128, 2432, -2432],
[421, -421, 842, -842, 1263, -1263, 1684, -1684, 2105, -2105, 2526, -2526, 2947, -2947, 3368, -3368],
[562, -562, 1124, -1124, 1686, -1686, 2248, -2248, 2810, -2810, 3372, -3372, 3934, -3934, 4496, -4496],
[731, -731, 1462, -1462, 2193, -2193, 2924, -2924, 3655, -3655, 4386, -4386, 5117, -5117, 5848, -5848],
[928, -928, 1856, -1856, 2784, -2784, 3712, -3712, 4640, -4640, 5568, -5568, 6496, -6496, 7424, -7424],
[1157, -1157, 2314, -2314, 3471, -3471, 4628, -4628, 5785, -5785, 6942, -6942, 8099, -8099, 9256, -9256],
[1419, -1419, 2838, -2838, 4257, -4257, 5676, -5676, 7095, -7095, 8514, -8514, 9933, -9933, 11352, -11352],
[1715, -1715, 3430, -3430, 5145, -5145, 6860, -6860, 8575, -8575, 10290, -10290, 12005, -12005, 13720, -13720],
[2048, -2048, 4096, -4096, 6144, -6144, 8192, -8192, 10240, -10240, 12288, -12288, 14336, -14336, 16384, -16384]]];
/* 	
	Mapping of quantized values to dequantized ones based on scalefactor,
	used bit width and quantized value. Table used by both encoder and decoder
*/

class QOA_BitStream {  // bitstream reader / writer
    constructor(initData) {
        this.buffer = initData ? new Uint8Array(initData) : new Uint8Array(1024);
        this.bufferedByte = 0;
        this.byteAt = 0;
        this.bitAt = 0;
        this.length = initData ? initData.length : 0;
    }
    _expandBuffer() {
        const newBuffer = new Uint8Array(this.buffer.length * 2);
        newBuffer.set(this.buffer);
        this.buffer = newBuffer;
    }
    write(value, size) {
        let mask = (1 << (size - 1)) >>> 0;
        for(let i=0; i < size; i++) {
            this.bufferedByte <<= 1;
            if(value & mask) {
                this.bufferedByte |= 1;
            }
            mask >>>= 1;
            this.bitAt++;
            if(this.bitAt == 8) {
                if(this.length >= this.buffer.length) {
                    this._expandBuffer();
                }
                this.buffer[this.length] = this.bufferedByte;
                this.length++;
                this.bufferedByte = 0;
                this.bitAt = 0;
            }
        }
    }
    read(size) {
        let value = 0;
        let mask = 1 << (this.bitAt - 1);
        for(let i=0; i < size; i++) {
            if(this.bitAt == 0) {
                if(this.byteAt >= this.length) {
                    return 0;
                }
                this.bufferedByte = this.buffer[this.byteAt];
                this.byteAt++;
                this.bitAt = 8;
                mask = 128;
            }
            value <<= 1;
            if(this.bufferedByte & mask) {
                value |= 1;
            }
            mask >>= 1;
            this.bitAt--;
        }
        return value;
    }
    seek(bitPos) {
        this.byteAt = bitPos >> 3;
        this.bitAt = (8 - (bitPos & 7)) & 7;
    }
    writeLast() {
        if(this.bitAt > 0) {
            if(this.length >= this.buffer.length) {
                this._expandBuffer();
            }
            this.buffer[this.length] = this.bufferedByte << (8 - this.bitAt);
            this.length++;
            this.bufferedByte = 0;
            this.bitAt = 0;
        }
    }
    get bytes() {
        return this.buffer.subarray(0, this.length);
    }
}

function fac_clamp(v, min, max) {
	return v < min ? min : v > max ? max : v;
}

function fac_clamp16(v) {
	return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

function LMS(h, w) {
	const history = new Int16Array(h);
	const weights = new Int16Array(w);
	return {history, weights};
}

function fac_lms_predict(weights, history) {
	let sum = 0;
	for(let i=0; i<FAC_LMS_LEN; i++) {
		sum += weights[i] * history[i];
	}
	return sum >> FAC_PRED_SHIFT;
}

function fac_lms_process(weights, history, sample, residual) {
	const delta = residual >> FAC_UPD_SHIFT;
	const deltaNeg = -delta;
	let prediction = 0;
	for(let i=0; i<FAC_LMS_LEN_M1; i++) {
		weights[i] += history[i] < 0 ? deltaNeg : delta;
		history[i] = history[i + 1];
		prediction += weights[i] * history[i];
	}
	weights[FAC_LMS_LEN_M1] += history[FAC_LMS_LEN_M1] < 0 ? deltaNeg : delta;
	history[FAC_LMS_LEN_M1] = sample;
	prediction += weights[FAC_LMS_LEN_M1] * history[FAC_LMS_LEN_M1];
	return prediction >> FAC_PRED_SHIFT;
}

function fac_div(v, scalefactor) {
	const reciprocal = fac_reciprocal_tab[scalefactor];
	let n = (v * reciprocal + (1 << 15)) >> 16;
	n = n + ((v > 0) - (v < 0)) - ((n > 0) - (n < 0)); /* round away from 0 */
	return n < -8 ? -8 : n > 8 ? 8 : n;
}

function qoa_encode_frame(stream, audio, lmses, sample_offset, frame_len) {
    const channels = audio.channels;
	const channelData = audio.channelData;
	const BPS = audio.bitsPerSample;
	stream.write(FAC_FRAME_MARK, 8);
	stream.write(frame_len, 16); // frame samples

	// write current LMS weights and history state
	for(let c=0; c<channels; c++) {
		const lms = lmses[c];
		for (let i=0; i<FAC_LMS_LEN; i++) {
			stream.write(lms.history[i], 16);
		}
		for (let i=0; i<FAC_LMS_LEN; i++) {
			stream.write(lms.weights[i], 16);
		}
	}

  /* We encode all samples with the channels interleaved on a slice level.
	E.g. for stereo: (ch-0, slice 0), (ch 1, slice 0), (ch 0, slice 1), ...*/
	const quant_table = fac_quant_tab[BPS - 1]; // selected quantization table
	const dequant_table = fac_dequant_tab[BPS - 1]; // dequantization table
	for(let s=0; s<frame_len; s+=FAC_SLICE_LEN) {
		for(let c=0; c<channels; c++) {
			const slice_len = fac_clamp(FAC_SLICE_LEN, 0, frame_len - s);
			const slice_start = s;
			const sampleData = channelData[c];
			/* Brute for search for the best scalefactor. Just go through all
			16 scalefactors, encode all samples for the current slice and 
			meassure the total squared error. */
			let best_errors = Number.MAX_SAFE_INTEGER;
			let best_slice;
			let best_slice_scalefactor;
			let best_lms;
			let best_resid;
			
			for(let scalefactor=0; scalefactor<16; scalefactor++) {
			/* We have to reset the LMS state to the last known good one
				before trying each scalefactor, as each pass updates the LMS
				state when encoding. */
				let lms = LMS(lmses[c].history, lmses[c].weights);
				const dequant_table_entry = dequant_table[scalefactor];
				let slice = [];
				let sliced_resid = [];
				let current_errors = 0;
				let idx = slice_start + sample_offset;
				let aborted = false;
				let predicted = fac_lms_predict(lms.weights, lms.history);
				for(let i=0; i<slice_len; i++) {
					let sample = sampleData[idx++];
					let residual = sample - predicted;
					sliced_resid.push(predicted);
					let scaled = fac_div(residual, scalefactor);
					let quantized = quant_table[scaled + 8];
					let dequantized = dequant_table_entry[quantized];
					let reconstructed = fac_clamp16(predicted + dequantized);
					let error = sample - reconstructed;
					current_errors += error * error;
					if(current_errors >= best_errors) {
						aborted = true;
						break;
					}
					predicted = fac_lms_process(lms.weights, lms.history, reconstructed, dequantized);
					slice.push(quantized);
				}
				if(!aborted) {
					best_errors = current_errors;
					best_slice = slice;
					best_slice_scalefactor = scalefactor;
					best_lms = lms;
					best_resid = sliced_resid;
				}
			}
			lmses[c] = best_lms;
			stream.write(best_slice_scalefactor, 4);
			// now write each datum in the slice
			for(let i=0; i<FAC_SLICE_LEN; i++) {
			// the last frame of a file might be smaller than FAC_SLICE_LEN
				const v = i < best_slice.length ? best_slice[i] : 0;
				stream.write(v, BPS);
			}
		}
	}
}

function qoa_encode({channelData, sampleRate = 44100, bitsPerSample = 3} = {}) {
	const channels = channelData.length;
	const samples = channels >= 1 ? channelData[0].length : 0;
	const audio = {samples, channels, channelData, bitsPerSample};
	
	if(bitsPerSample < 1 || bitsPerSample > 4) {
		throw new Error(`Bits per sample out of range [1 - 4]`);
	}
	
	const lmses = [];
	for(let c=0; c<audio.channels; c++) {
		const lms = LMS(FAC_LMS_LEN, FAC_LMS_LEN);
		lms.weights[FAC_LMS_LEN_M1 - 1] = -(1 << 13);
		lms.weights[FAC_LMS_LEN_M1] = 1 << 14;
		lmses.push(lms);
	}

	// write header
	const stream = new QOA_BitStream();
	stream.write(FAC_MAGIC, 32);
	stream.write(channels, 8);
	stream.write(samples, 32);
	stream.write(sampleRate, 24);
	stream.write(bitsPerSample, 8);

	let frame_len = FAC_FRAME_LEN;
	for(let s=0; s<samples; s+=frame_len) {
		frame_len = fac_clamp(FAC_FRAME_LEN, 0, samples - s);
		let sizeRef = stream.bytes.length;
        qoa_encode_frame(stream, audio, lmses, s, frame_len);
        let sizeDiff = stream.bytes.length - sizeRef;
	}
	stream.writeLast();
	return stream.bytes;
}

function decodeHeader(stream) {
	const magic = stream.read(32);
	if(magic !== FAC_MAGIC) {
		throw new Error(`Not a FAC file; expected magic number 'fac_'`);
	}
	const header = {
		channels: stream.read(8),
		samples: stream.read(32),
		sampleRate: stream.read(24),
		bitsPerSample: stream.read(8)
    };
	return header;
}

function qoa_decode_frame(stream, audio, lmses, channelData, sampleOffset) {
	const channels = audio.channels;
	const BPS = audio.bitsPerSample;
	/*
		Thanks to the frame header check, your ears won't blow up in case
		there is a flipped bit or a read error.
	*/
	if(stream.read(8) != FAC_FRAME_MARK) {
		throw new Error("Invalid frame header.");
	}
	const samples = stream.read(16); // frame samples
  
	// decode LMS history and weights
	for(let c=0; c<channels; c++) {
		const lms = lmses[c];
		for(let i=0; i<FAC_LMS_LEN; i++) {
			let h = stream.read(16);
			lms.history[i] = h;
		}
		for(let i=0; i<FAC_LMS_LEN; i++) {
			let w = stream.read(16);
			lms.weights[i] = w;
		}
	}
	
	for(let s=0; s<samples; s+=FAC_SLICE_LEN) {
		for(let c=0; c<channels; c++) {
			const slice_start = s;
			const theoretical_end = s + FAC_SLICE_LEN;
			const slice_end = samples < theoretical_end ? samples : theoretical_end;
			const slice_count = slice_end - slice_start;
			const lms = lmses[c];
			const sampleData = channelData[c];
			let idx = sampleOffset + slice_start;
			const weights = lms.weights;
			const history = lms.history;
			const scalefactor = stream.read(4);
			const dequant_table = fac_dequant_tab[BPS - 1][scalefactor];
			let bitsRemaining = FAC_SLICE_LEN * BPS;
			// note: this loop is a hot code path and could be optimized
			let predicted = fac_lms_predict(weights, history);
			for(let i=0; i<slice_count; i++) {
				const quantized = stream.read(BPS);
				const dequantized = dequant_table[quantized];
				const reconstructed = fac_clamp16(predicted + dequantized);
				sampleData[idx++] = reconstructed;
				predicted = fac_lms_process(weights, history, reconstructed, dequantized);
				bitsRemaining -= BPS;
			}
			// skip stream if needed
			if (bitsRemaining > 0) {
				stream.read(bitsRemaining);
			}
		}
	}
	return samples;
}

function qoa_decode(data) {
	const stream = new QOA_BitStream(data);
	const audio = decodeHeader(stream);
	if(audio.bitsPerSample < 1 || audio.bitsPerSample > 4) {
		throw new Error(`Bits per sample out of range [1 - 4]`);
	}
	const channelData = [];
	const lmses = [];
	for(let c=0; c<audio.channels; c++) {
		const d = new Int16Array(audio.samples);
		channelData.push(d);
		lmses.push(LMS(FAC_LMS_LEN, FAC_LMS_LEN));
	}
	let sampleIndex = 0;
	let frameLen = 0;
	do {
		frameLen = qoa_decode_frame(stream, audio, lmses, channelData, sampleIndex);
		sampleIndex += frameLen;
	} while(frameLen && sampleIndex < audio.samples);

	return {...audio, channelData};
}
