# FAC - The Fast Audio Codec

FAC is a unique audio codec intended for platforms with very limited computational power, such as <b>small microcontrollers</b> or the famous <b>Z80 CPU</b>.
As demonstrated in this <a href="https://youtu.be/kaUDCDXiM4w?si=L2NmCmnTsmfOteaB">video</a>, it was able to play glorious techno on Z80 without any hardware acceleration besides hardware SPI. FAC decoding is faster than ADPCM despite ADPCM being already very lightweight.

# What's the secret?

FAC encapsulates two encoders and one decoder compatible with both encoders. Responsibility for clever data processing lies all on the encoder side, the decoder has to vacantly read the data which encoder provided. One encoder is very fast and provides acceptable sound quality while the other can be computationally heavier than MP3. It does its best to squeeze the highest achievable sound quality out of the dumb decoder.

# FACts about FAC

- Inspired by <a href="https://en.wikipedia.org/wiki/Adaptive_differential_pulse-code_modulation">ADPCM</a> and <a href="https://github.com/phoboslab/qoa">QOA</a>
- Uses from 1 to 4 bits per quantized sample
- Fast encoder is faster than QOA and slightly slower than ADPCM
- Decoder is faster than both ADPCM and QOA
- Fast encoder provides quality comparable with ADPCM
- Slow encoder provides quality better than ADPCM
- Decoder doesn't use any fixed lookup tables, everything is provided in the encoded file

# Project Files

Files in this package are:
- <b>FAC.js</b>: Complete Fast Audio Codec software, JavaScript version. Python module written in C coming in the future.
- <b>QOA-modif.js</b>: Modified QOA codec software, JavaScript version.
- <b>Codec_tester_html</b>: Basic browser interface for testing FAC, QOA and ADPCM. Just run it in your web browser.
- <b>comparison folder</b>: Audio tracks encoded by FAC, ADPCM and QOA. Encoding settings marked in file names, original tracks included.

# Details

- Codec features and usage are described in the comments at the top of each source code.
