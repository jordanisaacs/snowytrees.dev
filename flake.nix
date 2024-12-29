{
  # https://lukebentleyfox.net/posts/building-this-blog/
  # building zola is based on ^ blog post
  inputs = {
    nixpkgs.url = "nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = { self, nixpkgs, flake-parts, ... }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" ];
      perSystem = { pkgs, ... }: {
        packages = let website = pkgs.callPackage ./site { };
        in {
          inherit website;
          default = website;
        };
        devShells.default =
          pkgs.mkShell { buildInputs = [ pkgs.zola pkgs.nixfmt ]; };
      };
    };
}
