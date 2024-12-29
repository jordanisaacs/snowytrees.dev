{ pkgs, ... }:
pkgs.stdenv.mkDerivation {
  pname = "snowytrees-site";
  version = "0.0.1";
  src = ./.;
  buildInputs = [ pkgs.zola ];
  buildPhase = ''
    zola build -o $out
  '';
}
