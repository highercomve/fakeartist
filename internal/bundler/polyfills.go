package bundler

var TextEncoderPolyfill = `function TextEncoder(){} TextEncoder.prototype.encode=function(string){var octets=[],length=string.length,i=0;while(i<length){var codePoint=string.codePointAt(i),c=0,bits=0;codePoint<=0x7F?(c=0,bits=0x00):codePoint<=0x7FF?(c=6,bits=0xC0):codePoint<=0xFFFF?(c=12,bits=0xE0):codePoint<=0x1FFFFF&&(c=18,bits=0xF0),octets.push(bits|(codePoint>>c)),c-=6;while(c>=0){octets.push(0x80|((codePoint>>c)&0x3F)),c-=6}i+=codePoint>=0x10000?2:1}return octets};function TextDecoder(){} TextDecoder.prototype.decode=function(octets){var string="",i=0;while(i<octets.length){var octet=octets[i],bytesNeeded=0,codePoint=0;octet<=0x7F?(bytesNeeded=0,codePoint=octet&0xFF):octet<=0xDF?(bytesNeeded=1,codePoint=octet&0x1F):octet<=0xEF?(bytesNeeded=2,codePoint=octet&0x0F):octet<=0xF4&&(bytesNeeded=3,codePoint=octet&0x07),octets.length-i-bytesNeeded>0?function(){for(var k=0;k<bytesNeeded;){octet=octets[i+k+1],codePoint=(codePoint<<6)|(octet&0x3F),k+=1}}():codePoint=0xFFFD,bytesNeeded=octets.length-i,string+=String.fromCodePoint(codePoint),i+=bytesNeeded+1}return string};`

var MessageChannelPolyfill = `if(typeof MessageChannel==="undefined"){var MessageChannel=function(){this.port1={postMessage:function(msg){setTimeout(()=>{this.onmessage&&this.onmessage({data:msg})},0)},onmessage:null},this.port2={postMessage:function(msg){setTimeout(()=>{this.onmessage&&this.onmessage({data:msg})},0)},onmessage:null}}}`

var ProcessPolyfill = `var process = {env: {NODE_ENV: "production"}};`

var URLPolyfill = `
if (typeof URL === "undefined") {
	function URL(url, base) {
		var parser = {
			protocol: "",
			host: "",
			hostname: "",
			port: "",
			pathname: "",
			search: "",
			hash: "",
			origin: "",
			href: "",
		};
		var pattern = /^(https?:)\/\/([^\/:?#]+)(:\d+)?([^?#]*)(\?[^#]*)?(#.*)?$/;
		var match = url.match(pattern);
		if (match) {
			parser.protocol = match[1] || "";
			parser.host = match[2] + (match[3] || "");
			parser.hostname = match[2] || "";
			parser.port = match[3] ? match[3].substring(1) : "";
			parser.pathname = match[4] || "/";
			parser.search = match[5] || "";
			parser.hash = match[6] || "";
			parser.origin = parser.protocol + "//" + parser.host;
			parser.href = parser.origin + parser.pathname + parser.search + parser.hash;
		} else {
			parser.href = url;
		}
		this.href = parser.href;
		this.protocol = parser.protocol;
		this.host = parser.host;
		this.hostname = parser.hostname;
		this.port = parser.port;
		this.pathname = parser.pathname;
		this.search = parser.search;
		this.hash = parser.hash;
		this.origin = parser.origin;
		var searchParams = {};
		var params = (this.search || "").replace(/^\?/, "").split("&");
		for (var i = 0; i < params.length; i++) {
			if (!params[i]) continue;
			var kv = params[i].split("=");
			searchParams[decodeURIComponent(kv[0])] = kv.length > 1 ? decodeURIComponent(kv[1]) : "";
		}
		this.searchParams = {
			set: function(key, value) {
				searchParams[key] = value;
				var s = [];
				for (var k in searchParams) {
					if (searchParams.hasOwnProperty(k)) {
						s.push(encodeURIComponent(k) + "=" + encodeURIComponent(searchParams[k]));
					}
				}
				this.search = s.length ? "?" + s.join("&") : "";
			}.bind(this),
			get: function(key) {
				return searchParams[key];
			},
			toString: function() {
				var s = [];
				for (var k in searchParams) {
					if (searchParams.hasOwnProperty(k)) {
						s.push(encodeURIComponent(k) + "=" + encodeURIComponent(searchParams[k]));
					}
				}
				return s.length ? "?" + s.join("&") : "";
			}
		};
	}
}
`
